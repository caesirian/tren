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
    revisado: false, // queda "sujeto a revisión" hasta que el admin lo marque
    timestamp: new Date().toISOString(),
  };

  const firestore = ensureInit();
  if (!firestore) {
    console.log("[reportes]", JSON.stringify(registro));
    return registro;
  }

  try {
    const ref = await firestore.collection("reportes").add({ ...registro, creadoEn: FieldValue.serverTimestamp() });
    return { ...registro, id: ref.id };
  } catch (err) {
    console.error("Error guardando reporte:", err.message);
    console.log("[reportes fallback]", JSON.stringify(registro));
  }
  return registro;
}

// Lista los reportes que todavía no fueron marcados como revisados.
export async function listarReportesPendientes(limite = 10) {
  const firestore = ensureInit();
  if (!firestore) return [];
  try {
    const snap = await firestore.collection("reportes").where("revisado", "==", false).limit(50).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return docs.slice(0, limite);
  } catch (err) {
    console.error("Error listando reportes pendientes:", err.message);
    return [];
  }
}

export async function marcarReporteRevisado(id) {
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection("reportes").doc(id).update({ revisado: true });
  } catch (err) {
    console.error("Error marcando reporte como revisado:", err.message);
  }
}
