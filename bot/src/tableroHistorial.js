// src/tableroHistorial.js
// Historial del tablero: cada pocos minutos se guarda una "foto" de lo que
// mostraba el tablero de Once y de Moreno (las mismas filas que usa la imagen),
// para poder pedir después "/tablero 10" y ver cómo estaba hace 10 minutos.
//
// Se guarda en Firestore (colección tableroHistorial, id = timestamp en ms) con
// respaldo en memoria si Firestore no está disponible. Retención: 3 horas.
// Quién guarda: el chequeo periódico del bot (cron, cada ~5 min) y, de
// costado, cada consulta al tablero del sitio, con un mínimo de 2 min entre
// fotos para no golpear de más al proxy ni a Firestore.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { filasParaTabla } from "./appTrenes.js";
import { getTramoLimitado, resumenTramo } from "./servicioLimitado.js";

const COLECCION = "tableroHistorial";
const CABECERAS = ["Once", "Moreno"];
const RETENCION_MIN = 180;
const MIN_ENTRE_FOTOS_MS = 2 * 60 * 1000;
const MAX_EN_MEMORIA = 120;
const TOLERANCIA_MIN = 10; // si no hay foto a menos de esto del momento pedido, se avisa

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
    console.error("Error inicializando Firebase en tableroHistorial:", err.message);
    return null;
  }
}

let enMemoria = []; // { ts, cabeceras, servicioLimitado }
let ultimaFoto = 0;
let guardando = null;

async function armarFoto() {
  const cabeceras = {};
  for (const nombre of CABECERAS) {
    try {
      const r = await filasParaTabla(nombre, 5);
      cabeceras[nombre] = { origenNombre: r.revisadas?.[0] || nombre, filas: r.filas || [], error: r.error || null };
    } catch (err) {
      cabeceras[nombre] = { origenNombre: nombre, filas: [], error: `no se pudo consultar (${err.message})` };
    }
  }
  const tramo = await getTramoLimitado().catch(() => null);
  return { ts: Date.now(), cabeceras, servicioLimitado: resumenTramo(tramo) };
}

// Guarda una foto ahora. Con { forzar: false } (default) respeta el mínimo de 2
// min entre fotos; con { forzar: true } guarda siempre. Nunca tira: si algo
// falla lo registra y sigue (no debe voltear el chequeo periódico ni el tablero).
export async function registrarSnapshot({ forzar = false } = {}) {
  if (!forzar && Date.now() - ultimaFoto < MIN_ENTRE_FOTOS_MS) return null;
  if (guardando) return guardando;
  ultimaFoto = Date.now();
  guardando = (async () => {
    try {
      const foto = await armarFoto();
      enMemoria.push(foto);
      enMemoria = enMemoria.slice(-MAX_EN_MEMORIA);
      const firestore = ensureInit();
      if (firestore) {
        await firestore.collection(COLECCION).doc(String(foto.ts)).set(foto);
        limpiarViejas(firestore).catch(() => {});
      }
      return foto;
    } catch (err) {
      console.error("Error guardando foto del tablero:", err.message);
      return null;
    } finally {
      guardando = null;
    }
  })();
  return guardando;
}

async function limpiarViejas(firestore) {
  const corte = Date.now() - RETENCION_MIN * 60 * 1000;
  enMemoria = enMemoria.filter((f) => f.ts >= corte);
  const snap = await firestore.collection(COLECCION).where("ts", "<", corte).limit(60).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

// Foto más cercana a "hace N minutos". Devuelve { foto, diferenciaMin } o null
// si no hay nada registrado dentro de la ventana de búsqueda.
export async function snapshotHaceMinutos(minutos, ahora = Date.now()) {
  const objetivo = ahora - minutos * 60 * 1000;
  const ventana = (TOLERANCIA_MIN + 5) * 60 * 1000;
  let candidatas = enMemoria.filter((f) => Math.abs(f.ts - objetivo) <= ventana);
  const firestore = ensureInit();
  if (firestore) {
    try {
      const snap = await firestore.collection(COLECCION).where("ts", ">=", objetivo - ventana).where("ts", "<=", objetivo + ventana).get();
      candidatas = candidatas.concat(snap.docs.map((d) => d.data()));
    } catch (err) {
      console.error("Error leyendo historial del tablero:", err.message);
    }
  }
  if (!candidatas.length) return null;
  candidatas.sort((a, b) => Math.abs(a.ts - objetivo) - Math.abs(b.ts - objetivo));
  const foto = candidatas[0];
  return { foto, diferenciaMin: Math.round(Math.abs(foto.ts - objetivo) / 60000), dentroDeTolerancia: Math.abs(foto.ts - objetivo) <= TOLERANCIA_MIN * 60 * 1000 };
}

// Rango de lo registrado (para explicar por qué no hay foto de ese momento).
export async function rangoRegistrado() {
  let minTs = enMemoria.length ? Math.min(...enMemoria.map((f) => f.ts)) : null;
  let maxTs = enMemoria.length ? Math.max(...enMemoria.map((f) => f.ts)) : null;
  const firestore = ensureInit();
  if (firestore) {
    try {
      const a = await firestore.collection(COLECCION).orderBy("ts", "asc").limit(1).get();
      const b = await firestore.collection(COLECCION).orderBy("ts", "desc").limit(1).get();
      if (!a.empty) minTs = minTs == null ? a.docs[0].data().ts : Math.min(minTs, a.docs[0].data().ts);
      if (!b.empty) maxTs = maxTs == null ? b.docs[0].data().ts : Math.max(maxTs, b.docs[0].data().ts);
    } catch (err) {
      console.error("Error leyendo rango del historial:", err.message);
    }
  }
  return minTs == null ? null : { desde: minTs, hasta: maxTs };
}
