// src/firestoreStatus.js
// Lee el estado en vivo del servicio ("semáforo") desde el mismo Firestore
// que usa trensarmientoenlinea.com.ar (mod.html), así el bot y la web
// muestran exactamente lo mismo.
//
// Colección/documento reales (confirmados contra mod.html): estadoServicio/actual
// Proyecto de Firebase: tren-sarmiento-en-linea
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

const ETIQUETAS_ESTADO = {
  normal: "Servicio normal",
  modificado: "Servicio con demoras",
  paro: "Servicio interrumpido",
};

export async function getEstadoServicio() {
  const firestore = ensureInit();
  if (!firestore) return null;

  try {
    const snap = await firestore.collection("estadoServicio").doc("actual").get();
    if (!snap.exists) return null;
    const d = snap.data();

    return {
      estado: d.estado || "normal",
      etiqueta: ETIQUETAS_ESTADO[d.estado] || "Servicio normal",
      mensaje: d.mensaje || "Sin alertas activas.",
      alertas: Array.isArray(d.alertas) ? d.alertas : [],
      ultimaActualizacion: d.ultimaActualizacion || null,
      actualizado: d.actualizado || null,
      vigencia: d.vigencia || null,
    };
  } catch (err) {
    console.error("Error leyendo estado de Firestore:", err.message);
    return null;
  }
}
