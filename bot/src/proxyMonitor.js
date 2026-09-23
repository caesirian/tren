// src/proxyMonitor.js
// Monitoreo automático del proxy de la app de Trenes Argentinos (ariedro),
// declarado FUENTE DE VERDAD por el admin (22/9). Dos funciones:
//
//  1) chequearCancelacionesProxy(): la llama el cron existente (/internal/check,
//     cada 10-15 min). Hace el barrido de Sarmiento y, si aparece una
//     cancelación NUEVA (no notificada antes), avisa al admin por privado.
//     Las demoras/leyendas no generan aviso propio (se ven en /apptrenes
//     scan); solo las cancelaciones, que es lo que pidió.
//     TODAVÍA no publica nada en el grupo (a pedido explícito, por ahora).
//
//  2) contextoProxyParaBot(): texto para el contexto de Gemini, con las
//     cancelaciones y leyendas QUE EL PROXY MUESTRA AHORA MISMO. Se usa para
//     responder preguntas en el grupo, con la misma prioridad que los avisos
//     de la fuente de verdad por texto (avisosFuente.js). Es "en vivo": no
//     depende de guardar/vencer nada, se arma con cada pregunta a partir del
//     barrido (cacheado 2 min).
//
// Interruptor: APP_TRENES_MONITOR_ACTIVO=false apaga las dos cosas.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { barridoEstructurado, datosServicio, textoCancelacion, trenesConOrigenInusual, hora } from "./appTrenes.js";

const COLECCION = "cancelacionesProxyVistas";
const COLECCION_ORIGEN = "origenesInusualesVistos";
const RETENCION_DIAS = 3;

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
    console.error("Error inicializando Firebase en proxyMonitor:", err.message);
    return null;
  }
}

export function monitorProxyActivo() {
  return String(process.env.APP_TRENES_MONITOR_ACTIVO ?? "true").trim().toLowerCase() !== "false";
}

let vistosEnMemoria = new Set(); // respaldo sin Firestore y para no repetir dentro del mismo proceso

// Clave estable para una cancelación puntual: mismo tren + misma estación +
// mismo día programado. Si la misma cancelación sigue apareciendo, no vuelve
// a avisar; si el tren de mañana con el mismo número se cancela, sí avisa.
function claveCancelacion(item) {
  const { est, s, prog } = datosServicio(item);
  const dia = prog ? new Date(prog).toISOString().slice(0, 10) : "s-fecha";
  return `${s.numero ?? "s-num"}-${est.id}-${dia}`;
}

async function yaVista(clave) {
  if (vistosEnMemoria.has(clave)) return true;
  const firestore = ensureInit();
  if (!firestore) return false;
  try {
    const doc = await firestore.collection(COLECCION).doc(clave).get();
    return doc.exists;
  } catch (err) {
    console.error("Error chequeando cancelación vista:", err.message);
    return false;
  }
}

async function marcarVista(clave) {
  vistosEnMemoria.add(clave);
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection(COLECCION).doc(clave).set({ timestamp: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error("Error guardando cancelación vista:", err.message);
  }
}

// Housekeeping liviano: borra marcas de más de RETENCION_DIAS para no acumular
// para siempre. Se llama una vez por chequeo; si falla no corta el flujo.
async function limpiarVistasViejas() {
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    const corte = new Date(Date.now() - RETENCION_DIAS * 24 * 60 * 60 * 1000);
    const snap = await firestore.collection(COLECCION).where("timestamp", "<", corte).limit(200).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  } catch (err) {
    console.error("Error limpiando cancelaciones vistas viejas:", err.message);
  }
}

function lineaCancelacion(item) {
  const { est, s, prog, destino } = datosServicio(item);
  return `• #${s.numero ?? "?"} ${est.nombre} → ${destino} · prog ${hora(prog)}\n   ❌ ${textoCancelacion(s.cancelacion)}`;
}

// Para el cron: detecta cancelaciones nuevas y arma el texto para avisar al
// admin. Devuelve { nuevas: [...], texto: string|null, erroresProxy: [...] }.
// Trenes que declaran salir de una estación distinta a la habitual (ej. los
// "locales" que oficialmente arrancan en Flores, saliendo de Liniers). Sirve
// para anticiparse: el dato suele aparecer con el tren en "Programado", antes
// de que realmente salga, así que avisar apenas se detecta da margen.
export async function chequearOrigenesInusuales() {
  if (!monitorProxyActivo()) return { nuevos: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado(); // comparte caché con el resto de los chequeos
  } catch (err) {
    console.error("Error consultando el proxy para orígenes inusuales:", err.message);
    return { nuevos: [], texto: null, error: err.message };
  }

  const candidatos = trenesConOrigenInusual(barrido.todos);
  const nuevos = [];
  for (const item of candidatos) {
    const d = datosServicio(item);
    const dia = d.prog ? new Date(d.prog).toISOString().slice(0, 10) : "s-fecha";
    const clave = `${d.s.numero ?? "s-num"}-${d.origenReal}-${dia}`;
    const firestore = ensureInit();
    let visto = vistosEnMemoria.has(clave);
    if (!visto && firestore) {
      try {
        visto = (await firestore.collection(COLECCION_ORIGEN).doc(clave).get()).exists;
      } catch (err) {
        console.error("Error chequeando origen inusual visto:", err.message);
      }
    }
    if (visto) continue;
    vistosEnMemoria.add(clave);
    if (firestore) firestore.collection(COLECCION_ORIGEN).doc(clave).set({ timestamp: FieldValue.serverTimestamp() }).catch((err) => console.error("Error guardando origen inusual:", err.message));
    nuevos.push(item);
  }
  if (!nuevos.length) return { nuevos: [], texto: null };

  const lineas = nuevos.map((item) => {
    const d = datosServicio(item);
    return `• #${d.s.numero ?? "?"} → ${d.destino} | sale de ${d.origenReal} (se lo vio en ${d.est.nombre}) · prog ${hora(d.prog)}${d.anden ? ` · andén ${d.anden}` : ""}`;
  });
  const texto =
    `🔀 ${nuevos.length} tren(es) con estación de origen distinta a la habitual (Once/Flores/Merlo/Moreno):\n\n` +
    lineas.join("\n") +
    `\n\n(Esto es lo que declara el proxy como estación de salida — se detecta antes de que el tren realmente salga, en cuanto figura "Programado". Sin confirmar todavía si "origen" es 100% ese campo — revisar con /apptrenes get si algo no cierra.)`;
  return { nuevos, texto };
}

export async function chequearCancelacionesProxy() {
  if (!monitorProxyActivo()) return { nuevas: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado({ forzar: true });
  } catch (err) {
    console.error("Error consultando el proxy de la app para cancelaciones:", err.message);
    return { nuevas: [], texto: null, error: err.message };
  }

  const canceladas = barrido.todos.filter((item) => item.r?.servicio?.cancelacion);
  const nuevas = [];
  for (const item of canceladas) {
    const clave = claveCancelacion(item);
    if (await yaVista(clave)) continue;
    await marcarVista(clave);
    nuevas.push(item);
  }
  limpiarVistasViejas().catch(() => {});

  if (!nuevas.length) return { nuevas: [], texto: null };
  const texto =
    `🚨 La app de Trenes Argentinos informa ${nuevas.length} cancelación(es) nueva(s) de Sarmiento:\n\n` +
    nuevas.map(lineaCancelacion).join("\n") +
    `\n\n(Detectado por el proxy no oficial; todavía no se publica en el grupo — /apptrenes scan para el panorama completo.)`;
  return { nuevas, texto };
}

// Para el contexto del bot al responder preguntas: cancelaciones y leyendas
// que el proxy muestra AHORA. Declarado fuente de verdad por el admin, así
// que se redacta con la misma prioridad que AVISOS VIGENTES DE LA FUENTE DE
// VERDAD. Devuelve null si no hay nada relevante o el monitor está apagado.
export async function contextoProxyParaBot() {
  if (!monitorProxyActivo()) return null;
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error("Error consultando el proxy de la app para el contexto:", err.message);
    return null;
  }
  const relevantes = barrido.todos.filter((item) => item.r?.servicio?.cancelacion || item.r?.servicio?.leyenda);
  if (!relevantes.length) return null;

  const lineas = relevantes.slice(0, 12).map((item) => {
    const { est, s, prog, estim, demora, destino, estado } = datosServicio(item);
    let l = `- #${s.numero ?? "?"} ${est.nombre} → ${destino} · prog ${hora(prog)}${estim ? ` / est ${hora(estim)}${demora != null ? ` (${demora >= 0 ? "+" : ""}${demora} min)` : ""}` : ""} · ${estado}`;
    if (s.cancelacion) l += `\n  ❌ Cancelado: ${textoCancelacion(s.cancelacion)}`;
    if (s.leyenda) l += `\n  📢 ${s.leyenda}`;
    return l;
  });

  return (
    `\n== ESTADO EN VIVO — APP TRENES ARGENTINOS (proxy no oficial; declarada fuente de verdad; consultado ahora mismo) ==\n` +
    lineas.join("\n") +
    `\nEsto es lo que el proxy de la app devuelve EN ESTE MOMENTO (no vencido, no hay que calcular vigencia): tiene la misma prioridad que los avisos de la fuente de verdad por texto. Un tren específico cancelado no implica que todo el ramal esté cortado; hablá solo del/de los tren(es) que aparecen acá salvo que haya varios en el mismo tramo y horario.`
  );
}
