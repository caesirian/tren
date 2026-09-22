// src/appTrenesAuto.js
// Interruptor de "escaneo automático completo": mientras esté activo, cada
// vez que corre el chequeo periódico del proxy (cron externo o timer
// interno, cada ~5 min) se manda al admin por privado el barrido COMPLETO
// (todas las estaciones, todos los servicios), no solo las cancelaciones.
// Pensado para prender durante un incidente puntual (choque, corte, etc.) y
// apagar después — no para dejarlo prendido siempre, porque satura de
// mensajes. Se activa/desactiva con /apptrenes auto on|off. Estado
// persistido en Firestore para sobrevivir reinicios de Render.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let activo = false;
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
    console.error("Error inicializando Firebase en appTrenesAuto:", err.message);
    return null;
  }
}

export function escaneoCompletoActivo() {
  return activo;
}

export async function cargarEscaneoCompleto() {
  const firestore = ensureInit();
  if (!firestore) return activo;
  try {
    const doc = await firestore.collection("configBot").doc("escaneoCompletoAppTrenes").get();
    activo = doc.exists && doc.data().activo === true;
    if (activo) console.log("Escaneo automático completo de la app de Trenes Argentinos: ACTIVO (restaurado desde Firestore)");
  } catch (err) {
    console.error("Error cargando estado de escaneo completo:", err.message);
  }
  return activo;
}

export async function setEscaneoCompleto(valor, quien) {
  activo = !!valor;
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection("configBot").doc("escaneoCompletoAppTrenes").set({ activo, cambiadoPor: quien || null, cambiadoEn: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.error("Error guardando estado de escaneo completo:", err.message);
  }
}
