// src/noticiaPublisher.js
// Publica noticias en la misma colección Firestore que usa el panel de
// Admin (Admin/index-mod4.html), con el mismo esquema exacto, para que
// una noticia publicada desde el bot se vea y edite igual que una
// publicada desde el panel.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
    console.error("Error inicializando Firebase en noticiaPublisher:", err.message);
    return null;
  }
}

export async function publicarNoticia({ titulo, contenido, creadoPor }) {
  const firestore = ensureInit();
  if (!firestore) throw new Error("Firestore no está configurado (faltan credenciales).");

  const ahora = new Date();
  await firestore.collection("noticias").add({
    titulo,
    contenido,
    foto: "",
    piedefoto: "",
    fecha: ahora.toISOString().slice(0, 16),
    fechaMs: ahora.getTime(),
    publicado: true,
    creadoPor,
    creadoEn: FieldValue.serverTimestamp(),
  });
}
