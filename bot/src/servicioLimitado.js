// src/servicioLimitado.js
// Estado de SERVICIO LIMITADO: el tramo del ramal donde los trenes SÍ circulan
// hoy (ej. accidente en Flores → solo circulan trenes entre Liniers y Moreno).
// Es temporal: siempre tiene vencimiento.
//
// Quién lo carga (de mayor a menor prioridad):
//  - "manual": el admin con /limitado <estación> <estación> [minutos] [motivo]
//  - "vivi":   la fuente de verdad del grupo, cuando avisa un tramo
//              ("servicio limitado entre Moreno y Liniers"), vía avisosFuente.js
//  - "proxy":  detección automática desde la app de Trenes Argentinos (los
//              trenes de hoy no arrancan/terminan en las cabeceras). Nunca pisa
//              a uno manual o de la fuente, y se apaga solo si deja de verse.
//
// Quién lo respeta: el contexto del bot (no inventa salidas desde estaciones
// fuera del tramo), el tablero en vivo y /tableroestacion, /apptrenes salidas.
//
// Este módulo no depende de appTrenes.js (para evitar imports circulares), por
// eso trae su propia lista de estaciones y su propio reconocedor de nombres.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const ESTACIONES_RAMAL = [
  "Once", "Caballito", "Flores", "Floresta", "Villa Luro", "Liniers", "Ciudadela", "Ramos Mejía",
  "Haedo", "Morón", "Castelar", "Ituzaingó", "San Antonio de Padua", "Merlo", "Paso del Rey", "Moreno",
];

const ALIAS = [
  ["once", 0], ["caballito", 1], ["flores", 2], ["floresta", 3], ["villa luro", 4], ["liniers", 5],
  ["ciudadela", 6], ["ramos mejia", 7], ["haedo", 8], ["moron", 9], ["castelar", 10], ["ituzaingo", 11],
  ["san antonio de padua", 12], ["san antonio", 12], ["padua", 12], ["merlo", 13], ["paso del rey", 14], ["moreno", 15],
];

const TTL_DEFAULT_MIN = 120;
const TTL_MIN_MIN = 10;
const TTL_MAX_MIN = 12 * 60;
const COLECCION = "servicioLimitado";
const DOC_ID = "actual";
const CACHE_MS = 15 * 1000;

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Índices (0 = Once … 15 = Moreno) de las estaciones que se nombran en un texto,
// en orden de aparición y sin repetir seguidas. "Flores" no confunde con "Floresta".
export function extraerEstaciones(texto) {
  const t = norm(texto);
  const hallazgos = [];
  for (const [alias, idx] of ALIAS) {
    const re = new RegExp(`\\b${alias}\\b`, "g");
    let m;
    while ((m = re.exec(t))) hallazgos.push({ pos: m.index, fin: m.index + alias.length, idx });
  }
  hallazgos.sort((a, b) => a.pos - b.pos || b.fin - a.fin);
  const res = [];
  let hasta = -1;
  for (const h of hallazgos) {
    if (h.pos < hasta) continue; // solapado con un alias más largo ya tomado ("san antonio de padua")
    hasta = h.fin;
    if (res[res.length - 1] !== h.idx) res.push(h.idx);
  }
  return res;
}

export function idxEstacion(nombre) {
  const r = extraerEstaciones(nombre);
  return r.length ? r[0] : -1;
}

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
    console.error("Error inicializando Firebase en servicioLimitado:", err.message);
    return null;
  }
}

let enMemoria = null; // respaldo si Firestore no está disponible
let cache = { momento: 0, valor: null };
let proxySuprimidoHasta = 0; // tras /limitado off, el proxy no vuelve a activarlo por un rato

function vigente(v) {
  return !!v && v.activo === true && typeof v.venceEn === "string" && v.venceEn > new Date().toISOString() && Number.isInteger(v.desdeIdx) && Number.isInteger(v.hastaIdx);
}

// Devuelve el tramo vigente o null. Cacheado unos segundos: lo consultan el
// tablero (cada 20 s por visitante) y cada pregunta al bot.
export async function getTramoLimitado() {
  if (Date.now() - cache.momento < CACHE_MS) return cache.valor;
  let v = enMemoria;
  const firestore = ensureInit();
  if (firestore) {
    try {
      const doc = await firestore.collection(COLECCION).doc(DOC_ID).get();
      if (doc.exists) v = doc.data();
    } catch (err) {
      console.error("Error leyendo servicio limitado:", err.message);
    }
  }
  const valor = vigente(v) ? v : null;
  cache = { momento: Date.now(), valor };
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
    console.error("Error guardando servicio limitado:", err.message);
  }
}

// estA/estB: índices de estación (0–15) o nombres. Devuelve el tramo guardado, o
// null si los datos no sirven (misma estación, nombre desconocido), o el tramo
// que ya estaba si un aviso del proxy intenta pisar uno manual / de la fuente.
export async function setTramoLimitado({ estA, estB, motivo = "", duracionMin = null, venceEn = null, origen = "manual", quien = null }) {
  const a = Number.isInteger(estA) ? estA : idxEstacion(estA);
  const b = Number.isInteger(estB) ? estB : idxEstacion(estB);
  if (a < 0 || b < 0 || a > 15 || b > 15 || a === b) return null;

  if (origen === "proxy") {
    if (Date.now() < proxySuprimidoHasta) return null;
    const actual = await getTramoLimitado();
    if (actual && actual.origen !== "proxy") return actual;
  }

  const ahora = new Date();
  const ms = (min) => Math.min(Math.max(min, TTL_MIN_MIN), TTL_MAX_MIN) * 60 * 1000;
  let vence;
  let estimado = false;
  if (venceEn) {
    vence = new Date(venceEn);
  } else if (Number.isFinite(duracionMin) && duracionMin > 0) {
    vence = new Date(ahora.getTime() + ms(duracionMin));
  } else {
    vence = new Date(ahora.getTime() + ms(origen === "proxy" ? 15 : TTL_DEFAULT_MIN));
    estimado = true;
  }
  const desdeIdx = Math.min(a, b);
  const hastaIdx = Math.max(a, b);
  const doc = {
    activo: true,
    desdeIdx,
    hastaIdx,
    desde: ESTACIONES_RAMAL[desdeIdx],
    hasta: ESTACIONES_RAMAL[hastaIdx],
    motivo: String(motivo || "").slice(0, 300),
    origen,
    quien,
    timestamp: ahora.toISOString(),
    venceEn: vence.toISOString(),
    vigenciaEstimada: estimado,
  };
  await guardar(doc);
  return doc;
}

// Cierra el servicio limitado. suprimirProxy=true (lo usa el /limitado off del
// admin) evita que la detección automática lo reactive durante una hora.
export async function limpiarTramoLimitado({ suprimirProxy = false } = {}) {
  if (suprimirProxy) proxySuprimidoHasta = Date.now() + 60 * 60 * 1000;
  const actual = enMemoria || cache.valor;
  await guardar({ ...(actual || {}), activo: false, cerradoEn: new Date().toISOString() });
}

export function tramoIncluye(tramo, idx) {
  return !!tramo && idx >= tramo.desdeIdx && idx <= tramo.hastaIdx;
}

function horaAR(fecha) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(fecha);
}

// Datos livianos para las APIs y el tablero.
export function resumenTramo(tramo) {
  if (!tramo) return null;
  const fuera = ESTACIONES_RAMAL.filter((_, i) => i < tramo.desdeIdx || i > tramo.hastaIdx);
  return {
    desde: tramo.desde,
    hasta: tramo.hasta,
    motivo: tramo.motivo || null,
    venceEn: tramo.venceEn,
    vigenciaEstimada: !!tramo.vigenciaEstimada,
    estacionesSinServicio: fuera,
    texto: `Servicio limitado: solo circulan trenes entre ${tramo.desde} y ${tramo.hasta}.`,
  };
}

export function textoTramoParaContexto(tramo, ahora = new Date()) {
  if (!tramo) return null;
  const fuera = ESTACIONES_RAMAL.filter((_, i) => i < tramo.desdeIdx || i > tramo.hastaIdx);
  const vence = new Date(tramo.venceEn);
  const restan = Math.max(1, Math.round((vence - ahora) / 60000));
  const vigencia = tramo.vigenciaEstimada
    ? `Vigencia ESTIMADA: hasta aprox. las ${horaAR(vence)} (unos ${restan} min más); puede normalizarse antes o extenderse.`
    : `Vigencia indicada: hasta las ${horaAR(vence)} (unos ${restan} min más).`;
  return (
    `\n== SERVICIO LIMITADO VIGENTE (manda sobre cualquier horario, cronograma o tren "programado") ==\n` +
    `Ahora mismo el servicio está LIMITADO: solo circulan trenes entre ${tramo.desde} y ${tramo.hasta} (ambas incluidas).${tramo.motivo ? ` Motivo: ${tramo.motivo}` : ""}\n` +
    `${vigencia}\n` +
    `Estaciones SIN servicio ahora: ${fuera.join(", ") || "ninguna"}.\n` +
    `REGLAS OBLIGATORIAS mientras esté vigente:\n` +
    `- NUNCA digas que salen o llegan trenes desde/hacia una estación sin servicio, ni que hay trenes Once–Moreno completos, aunque el cronograma los muestre: no están circulando.\n` +
    `- Si preguntan por salidas desde una estación sin servicio (ej. Once si el tramo empieza en ${tramo.desde}), decí claramente que por el servicio limitado no salen trenes de ahí por ahora.\n` +
    `- Para estaciones dentro del tramo, los trenes solo van y vienen dentro de ${tramo.desde}–${tramo.hasta}; decí hasta dónde llegan.\n` +
    `- No inventes alternativas de transporte ni horarios de normalización. Es TEMPORAL: pasada la vigencia vuelve a regir el estado normal.`
  );
}
