// src/privateChatLogger.js
// Registra las conversaciones privadas (chat 1 a 1) que le escriben al bot,
// para que puedas monitorear uso y comportamiento. NO registra mensajes del
// grupo (eso es otra cosa: ver complaintTracker.js, que no persiste texto,
// solo cuenta quejas).
//
// Se guarda en la misma cuenta de Firestore que el semáforo, colección
// "logsPrivados", un documento por mensaje. Si no hay credenciales de
// Firebase configuradas, cae a un console.log (queda en los logs de Render,
// pero sin quedar buscable ni persistente a largo plazo).

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
}

export async function registrarChatPrivado({ ctx, pregunta, respuesta, error = null }) {
  const from = ctx.from || {};
  const registro = {
    chatId: ctx.chat?.id ?? null,
    userId: from.id ?? null,
    username: from.username ?? null,
    nombre: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
    pregunta,
    respuesta: respuesta ?? null,
    error: error ?? null,
    timestamp: new Date().toISOString(),
  };

  const firestore = ensureInit();
  if (!firestore) {
    console.log("[logsPrivados]", JSON.stringify(registro));
    return;
  }

  try {
    await firestore.collection("logsPrivados").add({
      ...registro,
      creadoEn: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Error guardando log de chat privado:", err.message);
    console.log("[logsPrivados fallback]", JSON.stringify(registro));
  }
}
