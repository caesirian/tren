// src/reportLogger.js
// Guarda reportes de /reporte en Firestore, colección "reportes". Pensado
// para que cualquier usuario del grupo pueda avisar algo (mal estado de un
// coche, maltrato de un guarda, lo que sea) sin que quede expuesto
// públicamente en el grupo — solo vos lo ves, con fecha, hora y quién lo
// mandó.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
    console.error("Error inicializando Firebase en reportLogger:", err.message);
    return null;
  }
}

export async function guardarReporte({ ctx, mensaje }) {
  const from = ctx.from || {};
  const chat = ctx.chat || {};
  const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
  const origen = chat.type === "private" ? "privado" : `grupo (${chat.title || "sin nombre"})`;

  const registro = {
    userId: from.id ?? null,
    username: from.username ?? null,
    nombre: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
    quien,
    origen,
    mensaje,
    timestamp: new Date().toISOString(),
  };

  const firestore = ensureInit();
  if (!firestore) {
    console.log("[reportes]", JSON.stringify(registro));
    return registro;
  }

  try {
    await firestore.collection("reportes").add({ ...registro, creadoEn: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error("Error guardando reporte:", err.message);
    console.log("[reportes fallback]", JSON.stringify(registro));
  }
  return registro;
}
