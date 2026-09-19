// src/avisosFuente.js
// "Fuente de la verdad" por texto: lo que escriben en el grupo ciertas
// personas de confianza (por defecto @vivigo81, Vivi) sobre el estado del
// servicio — accidentes, servicio limitado, demoras, cortes — se toma como
// dato oficial del bot y manda por sobre el semáforo y la señal informal.
//
// Regla clave: un aviso NUNCA es indefinido. Todo aviso tiene vencimiento:
//  - si la fuente dice cuánto dura ("por 30 min", "hasta las 18:30") se usa eso;
//  - si no, se le asigna una vigencia estimada según el tipo (ver TTL_DEFAULT_MIN);
//  - si escribe que se normalizó, se cierran todos los avisos abiertos.
// Vencido el aviso, sale del contexto y el bot vuelve al estado oficial.
//
// Variable: FUENTES_VERDAD="vivigo81,123456" (usernames o IDs; se suman a los
// de por defecto).

import { GoogleGenAI } from "@google/genai";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash-lite";

const FUENTES_DEFAULT = ["vivigo81"];
const TTL_DEFAULT_MIN = { accidente: 90, servicio_limitado: 120, demora: 60, interrumpido: 120, otro_relevante: 60 };
const TTL_MIN_MIN = 10;
const TTL_MAX_MIN = 12 * 60;
const COLECCION = "avisosFuente";
const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3 fijo, sin horario de verano

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
    console.error("Error inicializando Firebase en avisosFuente:", err.message);
    return null;
  }
}

// Respaldo en memoria: si Firestore no está disponible, igual funciona hasta
// el próximo reinicio.
let enMemoria = []; // { id, ...aviso }

export function esFuenteVerdad(ctx) {
  const lista = `${FUENTES_DEFAULT.join(",")},${process.env.FUENTES_VERDAD || ""}`
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const id = String(ctx.from?.id ?? "").toLowerCase();
  const user = (ctx.from?.username || "").toLowerCase();
  return lista.includes(id) || (!!user && lista.includes(user));
}

function horaAR(fecha) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(fecha);
}

function limpiarJSON(t) {
  return t.replace(/```json|```/g, "").trim();
}

async function clasificar(texto, ahora) {
  const prompt = `
Sos un clasificador. El siguiente mensaje lo escribió en el grupo de Telegram del Tren Sarmiento una persona de confianza que informa sobre el estado del servicio. Hora actual en Buenos Aires: ${horaAR(ahora)}.

Mensaje: """${texto}"""

Devolvé SOLO un JSON (sin markdown ni texto extra) con esta forma exacta:
{
  "esAviso": true o false,
  "tipo": "accidente" | "servicio_limitado" | "demora" | "interrumpido" | "normalizacion" | "otro_relevante" | "ninguno",
  "resumen": "1 oración en español rioplatense con lo que informa, sin inventar nada",
  "duracionMin": número de minutos que dice que va a durar, o null si no lo dice,
  "venceHora": "HH:MM" (24hs, hora de Buenos Aires) si dice hasta qué hora dura, o null
}

Criterios:
- "accidente": accidente, atropello, persona en las vías, choque, descarrilamiento, etc.
- "servicio_limitado": el servicio circula limitado o parcial (ej. solo hasta cierta estación, un solo andén, frecuencia reducida).
- "demora": demoras o esperas sin corte.
- "interrumpido": servicio cortado/suspendido.
- "normalizacion": informa que el servicio se normalizó / se restableció / ya circula normal.
- "otro_relevante": otro dato operativo útil para pasajeros (obra, desvío, cambio de andén).
- Si es charla común, una pregunta, un saludo, un comentario sin dato del servicio: esAviso=false, tipo="ninguno".
- No inventes duraciones: si no las dice, null.
`.trim();

  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return JSON.parse(limpiarJSON(response.text.trim()));
}

// Fallback si Gemini falla: heurística simple para no perder un aviso real.
function clasificarPorPalabras(texto) {
  const t = texto.toLowerCase();
  if (/normaliz|restablec|ya circula|circula normal|servicio normal/.test(t)) return { esAviso: true, tipo: "normalizacion", resumen: texto.slice(0, 200), duracionMin: null, venceHora: null };
  if (/accidente|atropell|persona en (las )?v[ií]as|choque|descarril/.test(t)) return { esAviso: true, tipo: "accidente", resumen: texto.slice(0, 200), duracionMin: null, venceHora: null };
  if (/limitado|parcial|solo hasta|s[oó]lo hasta|un solo and[eé]n/.test(t)) return { esAviso: true, tipo: "servicio_limitado", resumen: texto.slice(0, 200), duracionMin: null, venceHora: null };
  if (/interrumpid|suspendid|cortado|sin servicio/.test(t)) return { esAviso: true, tipo: "interrumpido", resumen: texto.slice(0, 200), duracionMin: null, venceHora: null };
  if (/demora|retraso/.test(t)) return { esAviso: true, tipo: "demora", resumen: texto.slice(0, 200), duracionMin: null, venceHora: null };
  return { esAviso: false, tipo: "ninguno" };
}

// Calcula cuándo vence. Devuelve { venceEn: Date, estimado: boolean }.
export function calcularVencimiento({ tipo, duracionMin, venceHora }, ahora = new Date()) {
  const ttlDefault = TTL_DEFAULT_MIN[tipo] ?? 60;
  const ms = (min) => Math.min(Math.max(min, TTL_MIN_MIN), TTL_MAX_MIN) * 60 * 1000;

  if (Number.isFinite(duracionMin) && duracionMin > 0) {
    return { venceEn: new Date(ahora.getTime() + ms(duracionMin)), estimado: false };
  }

  const m = /^(\d{1,2}):(\d{2})$/.exec(venceHora || "");
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 24 && mm < 60) {
      const ar = new Date(ahora.getTime() - AR_OFFSET_MS); // campos UTC = reloj de Buenos Aires
      let objetivo = Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate(), hh, mm) + AR_OFFSET_MS;
      if (objetivo <= ahora.getTime()) objetivo += 24 * 60 * 60 * 1000;
      const dif = objetivo - ahora.getTime();
      if (dif <= TTL_MAX_MIN * 60 * 1000) {
        return { venceEn: new Date(ahora.getTime() + Math.max(dif, TTL_MIN_MIN * 60 * 1000)), estimado: false };
      }
    }
  }
  return { venceEn: new Date(ahora.getTime() + ms(ttlDefault)), estimado: true };
}

async function cerrarAvisosAbiertos(ahora) {
  const iso = ahora.toISOString();
  enMemoria = enMemoria.map((a) => (a.venceEn > iso ? { ...a, cerrado: true } : a));
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    const snap = await firestore.collection(COLECCION).where("venceEn", ">", iso).get();
    const abiertos = snap.docs.filter((d) => !d.data().cerrado);
    await Promise.all(abiertos.map((d) => d.ref.update({ cerrado: true, cerradoEn: iso })));
  } catch (err) {
    console.error("Error cerrando avisos:", err.message);
  }
}

// Procesa un mensaje de la fuente. Devuelve el aviso guardado, "normalizado"
// si cerró los abiertos, o null si no era un aviso.
export async function procesarMensajeFuente({ texto, quien, userId }) {
  const limpio = (texto || "").trim();
  if (limpio.length < 8 || limpio.startsWith("/")) return null;

  const ahora = new Date();
  let clasif;
  try {
    clasif = await clasificar(limpio, ahora);
  } catch (err) {
    console.warn("avisosFuente: Gemini falló, uso heurística:", err.message);
    clasif = clasificarPorPalabras(limpio);
  }
  if (!clasif?.esAviso || clasif.tipo === "ninguno") return null;

  if (clasif.tipo === "normalizacion") {
    await cerrarAvisosAbiertos(ahora);
    return "normalizado";
  }

  const { venceEn, estimado } = calcularVencimiento(clasif, ahora);
  const aviso = {
    tipo: clasif.tipo,
    resumen: String(clasif.resumen || limpio).slice(0, 300),
    textoOriginal: limpio.slice(0, 500),
    creadoPor: quien,
    userId: userId ?? null,
    timestamp: ahora.toISOString(),
    venceEn: venceEn.toISOString(),
    vigenciaEstimada: estimado,
    cerrado: false,
  };

  const firestore = ensureInit();
  let id = null;
  if (firestore) {
    try {
      const ref = await firestore.collection(COLECCION).add({ ...aviso, creadoEn: FieldValue.serverTimestamp() });
      id = ref.id;
    } catch (err) {
      console.error("Error guardando aviso de fuente:", err.message);
    }
  }
  if (!id) enMemoria.push({ id: `mem-${Date.now()}`, ...aviso });
  return aviso;
}

// Avisos que siguen vigentes ahora (no vencidos ni cerrados), el más nuevo primero.
export async function avisosVigentes() {
  const iso = new Date().toISOString();
  const firestore = ensureInit();
  let lista = enMemoria.filter((a) => a.venceEn > iso && !a.cerrado);
  if (firestore) {
    try {
      const snap = await firestore.collection(COLECCION).where("venceEn", ">", iso).get();
      lista = lista.concat(snap.docs.map((d) => d.data()).filter((a) => !a.cerrado));
    } catch (err) {
      console.error("Error trayendo avisos vigentes:", err.message);
    }
  }
  return lista.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// Para el admin (/avisos limpiar): cierra todo lo abierto a mano.
export async function cerrarTodosLosAvisos() {
  await cerrarAvisosAbiertos(new Date());
}

export function textoAvisosParaContexto(avisos, ahora = new Date()) {
  const lineas = avisos.map((a) => {
    const hace = Math.max(0, Math.round((ahora - new Date(a.timestamp)) / 60000));
    const vence = new Date(a.venceEn);
    const restan = Math.max(1, Math.round((vence - ahora) / 60000));
    const vigencia = a.vigenciaEstimada
      ? `Vigencia ESTIMADA (la fuente no dijo cuánto dura): hasta aprox. las ${horaAR(vence)} (unos ${restan} min más). Puede normalizarse antes o extenderse si hay novedades.`
      : `Vigencia indicada por la fuente: hasta las ${horaAR(vence)} (unos ${restan} min más).`;
    return `- [${a.tipo.replace("_", " ")}] Informado hace ${hace} min (${horaAR(new Date(a.timestamp))}): ${a.resumen}\n  Texto original: "${a.textoOriginal}"\n  ${vigencia}`;
  });
  return `\n== AVISOS VIGENTES DE LA FUENTE DE VERDAD (información más confiable y actual; manda sobre todo lo demás) ==\n${lineas.join("\n")}\nEstos avisos son TEMPORALES, nunca indefinidos: pasada la hora de vigencia dejan de aplicar y vuelve a regir el estado oficial.`;
}
