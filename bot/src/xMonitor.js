// src/xMonitor.js
// Lee el último tweet de @InfoTSarmiento (cuenta oficial de Trenes
// Argentinos para el Sarmiento) vía Nitter (front-end libre que expone
// RSS sin necesitar cuenta ni API de X) y lo usa como fuente de verdad
// para actualizar el semáforo del servicio en Firestore — el mismo
// documento que ya usan /estado y el sitio, así que todo queda sujeto a
// lo que diga la cuenta, en cascada, sin tocar nada más.
//
// X viene bloqueando el scraping directo cada vez más agresivo, y las
// instancias públicas de Nitter no son 100% confiables (dependen de que
// alguien las mantenga corriendo). Por eso: varias instancias de
// respaldo, timeout corto, y si todas fallan no se rompe nada — se
// registra el fallo y listo, se reintenta en el próximo ping.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { actualizarEstadoServicio } from "./firestoreStatus.js";

const CUENTA_X = "InfoTSarmiento";
const NITTER_INSTANCIAS = [
  "nitter.net",
  "xcancel.com",
  "nitter.poast.org",
  "nitter.tiekoetter.com",
];
const TIMEOUT_MS = 8000;

let db = null;
function ensureInit() {
  if (db) return db;
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    return null;
  }
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
    console.error("Error inicializando Firebase en xMonitor:", err.message);
    return null;
  }
}

function limpiarEntidadesHtml(texto) {
  return texto
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "") // Nitter a veces mete un link "RT by..." en HTML
    .trim();
}

async function fetchConTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Devuelve { texto, fecha, fuente } del tweet más reciente, o null si
// ninguna fuente respondió. Primero prueba el endpoint de sindicación de
// X (el que usa el propio X para los widgets de "insertar tuit" — oficial,
// pensado para lectura pública, no requiere cuenta ni API key), y si falla
// cae a las instancias de Nitter.
export async function obtenerUltimoTweet() {
  try {
    const json = await fetchConTimeout(
      `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${CUENTA_X}&showReplies=false&lang=es`
    );
    const data = JSON.parse(json);
    // El endpoint devuelve un HTML embebido con los tuits (headerContent) o,
    // según la versión, un array de entries — probamos ambas formas.
    const bloque = data?.body || JSON.stringify(data);
    const textoMatch = bloque.match(/<p[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (textoMatch) {
      return { texto: limpiarEntidadesHtml(textoMatch[1]), fecha: null, fuente: "syndication.twimg.com" };
    }
    console.error("xMonitor: syndication.twimg.com respondió pero no matcheó el formato esperado");
  } catch (err) {
    console.error("xMonitor: syndication.twimg.com falló:", err.message);
  }

  for (const instancia of NITTER_INSTANCIAS) {
    try {
      const xml = await fetchConTimeout(`https://${instancia}/${CUENTA_X}/rss`);
      const match = xml.match(/<item>([\s\S]*?)<\/item>/);
      if (!match) {
        console.error(`xMonitor: instancia ${instancia} respondió pero sin <item> en el RSS (primeros 200 caracteres): ${xml.slice(0, 200).replace(/\n/g, " ")}`);
        continue;
      }
      const item = match[1];
      const tituloMatch = item.match(/<title>([\s\S]*?)<\/title>/);
      const fechaMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!tituloMatch) {
        console.error(`xMonitor: instancia ${instancia} tiene <item> pero sin <title>`);
        continue;
      }
      return {
        texto: limpiarEntidadesHtml(tituloMatch[1]),
        fecha: fechaMatch ? new Date(fechaMatch[1].trim()) : null,
        fuente: instancia,
      };
    } catch (err) {
      console.error(`xMonitor: instancia ${instancia} falló:`, err.message);
      continue;
    }
  }
  return null;
}

// 🟢 = normal, 🟠/🟡 = demoras/modificado, 🔴 = paro/interrumpido.
function categorizarTweet(texto) {
  if (texto.includes("🔴")) return "paro";
  if (texto.includes("🟠") || texto.includes("🟡")) return "modificado";
  if (texto.includes("🟢")) return "normal";
  return null; // no es un tweet de estado (puede ser otro tipo de post)
}

let fallosConsecutivos = 0;
const UMBRAL_AVISO = 6; // ~1-1.5hs de pings sin que ninguna instancia responda

// Se llama desde el ping periódico. Compara contra el último tweet ya
// procesado (guardado en botInternal/xMonitor) para no reescribir Firestore
// de nuevo con el mismo tweet, y solo actualiza el semáforo cuando hay uno
// NUEVO y categorizable.
// Interruptor: con X_MONITOR_ACTIVO=false en las variables de entorno el
// monitoreo queda apagado (no consulta Nitter/X, no toca el semáforo ni avisa
// de fallos). Para reactivarlo, poner "true" o borrar la variable.
export function monitorXActivo() {
  return String(process.env.X_MONITOR_ACTIVO ?? "true").trim().toLowerCase() !== "false";
}

export async function chequearYActualizarDesdeX() {
  if (!monitorXActivo()) return { actualizado: false, motivo: "monitoreo de X desactivado (X_MONITOR_ACTIVO=false)" };
  const firestore = ensureInit();
  if (!firestore) return { actualizado: false, motivo: "sin Firestore" };

  const tweet = await obtenerUltimoTweet();
  if (!tweet) {
    fallosConsecutivos++;
    const avisar = fallosConsecutivos === UMBRAL_AVISO; // avisa una sola vez, no en cada ping
    return { actualizado: false, motivo: "ninguna instancia de Nitter respondió", avisarFalloPersistente: avisar, fallosConsecutivos };
  }
  fallosConsecutivos = 0;

  const ref = firestore.collection("botInternal").doc("xMonitor");
  const snap = await ref.get();
  const ultimoTextoProcesado = snap.exists ? snap.data().ultimoTexto : null;

  if (tweet.texto === ultimoTextoProcesado) {
    return { actualizado: false, motivo: "mismo tweet que la última vez" };
  }

  const estado = categorizarTweet(tweet.texto);
  await ref.set(
    { ultimoTexto: tweet.texto, ultimaFecha: tweet.fecha ? tweet.fecha.toISOString() : null, fuente: tweet.fuente, ultimoChequeo: new Date().toISOString() },
    { merge: true }
  );

  if (!estado) {
    // Es un tweet nuevo pero no trae emoji de estado (puede ser un
    // recordatorio, una promo, etc.) — lo registramos como visto pero no
    // tocamos el semáforo.
    return { actualizado: false, motivo: "tweet nuevo sin emoji de estado reconocible", texto: tweet.texto };
  }

  await actualizarEstadoServicio({ estado, mensaje: tweet.texto, editor: `Auto (X @${CUENTA_X})` });
  return { actualizado: true, estado, texto: tweet.texto };
}
