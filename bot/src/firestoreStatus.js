// src/firestoreStatus.js
// Lee el estado en vivo del servicio ("semáforo") desde el mismo Firestore
// que usa trensarmientoenlinea.com.ar, así el bot y la web muestran lo mismo.
//
// Requiere las credenciales de un service account de Firebase (variables
// de entorno FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).
// Si no se configuran, el bot sigue funcionando solo con datos fijos.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let db = null;

function ensureInit() {
  if (db) return db;
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    return null;
  }
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Render guarda saltos de línea como \n literal en la variable de entorno
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
  db = getFirestore();
  return db;
}

// AJUSTAR: reemplazar "estadoServicio" y "sarmiento" por la colección/doc
// reales que ya usás en mod.html para el semáforo.
export async function getEstadoServicio() {
  const firestore = ensureInit();
  if (!firestore) return null;

  try {
    const snap = await firestore
      .collection("estadoServicio")
      .doc("sarmiento")
      .get();
    if (!snap.exists) return null;
    const data = snap.data();
    return {
      estado: data.estado ?? "sin datos",
      mensaje: data.mensaje ?? "",
      actualizado: data.actualizadoEn?.toDate?.() ?? null,
    };
  } catch (err) {
    console.error("Error leyendo estado de Firestore:", err.message);
    return null;
  }
}
