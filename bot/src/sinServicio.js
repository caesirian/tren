// src/sinServicio.js
// Estado interno "SERVICIO SUSPENDIDO": cuando ya se sabe que no hay (o casi no
// hay) trenes, el bot NO publica en el grupo cancelación por cancelación,
// demoras ni locales fuera de cronograma — sería spam sobre algo que ya se sabe.
//
// Se considera suspendido si se cumple CUALQUIERA de:
//  0) estamos dentro de una VENTANA PROGRAMADA conocida de antemano (ver
//     VENTANAS_DEFAULT / SIN_SERVICIO_VENTANAS): empieza y termina sola, sin que
//     nadie tenga que avisarle al bot. Solo /sinservicio off la anula antes;
//  1) interruptor guardado (configBot/sinServicio), puesto a mano con
//     /sinservicio o automáticamente cuando un mismo chequeo del proxy trae
//     una ola de cancelaciones (ver index.js, CANCELACIONES_MASIVAS_MIN);
//  2) hay un aviso vigente de la fuente de verdad de tipo "interrumpido" que
//     no nombra un tramo (corte total, no parcial);
//  3) el semáforo del sitio está en "paro" (Servicio interrumpido).
// Todo vence solo (el interruptor guardado siempre trae "hasta"), y una
// normalización informada por la fuente lo levanta (ver index.js).

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { avisosVigentes } from "./avisosFuente.js";
import { getEstadoServicio } from "./firestoreStatus.js";
import { extraerEstaciones } from "./servicioLimitado.js";

const COLECCION = "configBot";
const DOC_ID = "sinServicio";
const CACHE_MS = 15 * 1000;
const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3 fijo

let db = null;
function ensureInit() {
  if (db) return db;
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) return null;
  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    db = getFirestore();
    return db;
  } catch (err) {
    console.error("Error inicializando Firebase en sinServicio:", err.message);
    return null;
  }
}

let enMemoria = null;
let cache = { momento: 0, valor: null, crudo: null };

const vigente = (v) => !!v && v.activo === true && typeof v.hasta === "string" && v.hasta > new Date().toISOString();

// Fin del día de hoy en Buenos Aires (23:59:59.999).
export function finDelDiaAR(ahora = new Date()) {
  const ar = new Date(ahora.getTime() - AR_OFFSET_MS); // campos UTC = reloj de Buenos Aires
  return new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate(), 23, 59, 59, 999) + AR_OFFSET_MS);
}

// Ventanas sin servicio conocidas de antemano. desde/hasta: "YYYY-MM-DD" (00:00 de
// Buenos Aires) o fecha ISO completa. "hasta" es el instante en que el servicio
// vuelve a la normalidad. Se pueden reemplazar con la variable de entorno
// SIN_SERVICIO_VENTANAS (JSON: [{"desde":"...","hasta":"...","motivo":"..."}]).
// Pasada la fecha, la entrada queda inerte.
const VENTANAS_DEFAULT = [
  { desde: "2026-10-10", hasta: "2026-10-13", motivo: "Corte programado del servicio del 10 al 12/10; se normaliza el martes 13/10" },
];

function parseFechaVentana(x) {
  const t = String(x || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + AR_OFFSET_MS);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ventanas() {
  let lista = VENTANAS_DEFAULT;
  if (process.env.SIN_SERVICIO_VENTANAS) {
    try {
      const e = JSON.parse(process.env.SIN_SERVICIO_VENTANAS);
      if (Array.isArray(e)) lista = e;
    } catch (err) {
      console.error("SIN_SERVICIO_VENTANAS inválida, uso la ventana por defecto:", err.message);
    }
  }
  return lista
    .map((v) => ({ desde: parseFechaVentana(v.desde), hasta: parseFechaVentana(v.hasta), motivo: v.motivo || "" }))
    .filter((v) => v.desde && v.hasta && v.hasta > v.desde);
}

function ventanaActiva(ahora = new Date()) {
  return ventanas().find((v) => ahora >= v.desde && ahora < v.hasta) || null;
}

async function leerInterruptor() {
  if (Date.now() - cache.momento < CACHE_MS) return cache.valor;
  let v = enMemoria;
  const firestore = ensureInit();
  if (firestore) {
    try {
      const doc = await firestore.collection(COLECCION).doc(DOC_ID).get();
      if (doc.exists) v = doc.data();
    } catch (err) {
      console.error("Error leyendo sinServicio:", err.message);
    }
  }
  const valor = vigente(v) ? v : null;
  cache = { momento: Date.now(), valor, crudo: v };
  return valor;
}

async function guardar(doc) {
  enMemoria = doc;
  cache = { momento: 0, valor: null };
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection(COLECCION).doc(DOC_ID).set(doc);
  } catch (err) {
    console.error("Error guardando sinServicio:", err.message);
  }
}

// Activa el interruptor. hasta: Date (por defecto, fin del día de hoy).
export async function setSinServicio({ motivo = "", hasta = null, fuente = "manual", quien = null } = {}) {
  const ventana = ventanaActiva();
  const fin = hasta instanceof Date && hasta.getTime() > Date.now() ? hasta : ventana ? ventana.hasta : finDelDiaAR();
  const doc = { activo: true, motivo: String(motivo || "").slice(0, 200), desde: new Date().toISOString(), hasta: fin.toISOString(), fuente, quien };
  await guardar(doc);
  return doc;
}

// manual=true (solo /sinservicio off): además anula la ventana programada en curso.
// Una normalización informada por la fuente NO la anula: la ventana termina sola.
export async function limpiarSinServicio({ manual = false } = {}) {
  await guardar({ activo: false, apagadoEn: new Date().toISOString(), apagadoManual: manual });
}

// Devuelve { fuente, motivo, hasta } si el servicio está suspendido ahora, o null.
export async function servicioSuspendido(ahora = new Date()) {
  const sw = await leerInterruptor();
  if (sw) return { fuente: sw.fuente || "manual", motivo: sw.motivo || "", hasta: sw.hasta };

  // Ventana programada: automática, salvo que el admin la haya apagado a mano con /sinservicio off.
  const ventana = ventanaActiva(ahora);
  if (ventana) {
    const crudo = cache.crudo;
    const apagadaAMano = crudo?.activo === false && crudo.apagadoManual === true && crudo.apagadoEn && new Date(crudo.apagadoEn) >= ventana.desde;
    if (!apagadaAMano) return { fuente: "programado", motivo: ventana.motivo, hasta: ventana.hasta.toISOString() };
  }

  try {
    const avisos = await avisosVigentes();
    const corte = avisos.find((a) => a.tipo === "interrumpido" && extraerEstaciones(`${a.resumen} ${a.textoOriginal || ""}`).length < 2);
    if (corte) return { fuente: "aviso", motivo: corte.resumen, hasta: corte.venceEn };
  } catch {}

  try {
    // Semáforo en "paro": cuenta solo mientras no venza su vigencia; sin vigencia, un máximo de 18 h
    // desde la última actualización (así nunca queda silenciado indefinidamente si nadie lo apaga).
    const e = await getEstadoServicio();
    if (e?.estado === "paro") {
      const hastaV = e.vigencia?.hasta ? new Date(e.vigencia.hasta) : null;
      const act = e.actualizado ? new Date(e.actualizado) : null;
      const tope = hastaV && !Number.isNaN(hastaV.getTime()) ? hastaV : act && !Number.isNaN(act.getTime()) ? new Date(act.getTime() + 18 * 3600 * 1000) : null;
      if (tope && tope > ahora) return { fuente: "semaforo", motivo: e.mensaje || "", hasta: tope.toISOString() };
    }
  } catch {}

  return null;
}

export function textoSuspendidoParaContexto(s) {
  const hasta = s.hasta ? ` Rige hasta aprox. ${new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s.hasta))}.` : "";
  return `\n== SERVICIO SUSPENDIDO (no hay trenes circulando con normalidad ahora) ==\n${s.motivo ? `Motivo/aviso: ${s.motivo}\n` : ""}Ya se sabe que el servicio está interrumpido o casi sin trenes: es el estado actual.${hasta}\nAnte "¿cómo anda el servicio?" decí que hoy el servicio está interrumpido/suspendido y NUNCA "funciona con normalidad". No enumeres cancelaciones tren por tren: ya se sabe que no hay servicio.`;
}
