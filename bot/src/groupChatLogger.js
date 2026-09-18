// src/groupChatLogger.js
// Registra las interacciones del GRUPO en las que el bot efectivamente
// intentó responder (mención, reply, o "pregunta al aire" que activó una
// respuesta) — no cada mensaje que pasa por el grupo, eso ya lo cubre
// complaintTracker.js sin guardar texto. Acá sí guardamos pregunta y
// respuesta (o el motivo del fallo), igual que privateChatLogger.js, para
// poder armar el mismo tipo de informe que con los chats privados.
//
// Se guarda en la misma cuenta de Firestore, colección "logsGrupo". Sin
// credenciales de Firebase configuradas, cae a un console.log (queda en los
// logs de Render, sin quedar buscable a largo plazo).

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
    console.error("Error inicializando Firebase (revisar FIREBASE_PRIVATE_KEY):", err.message);
    return null;
  }
}

// Detecta el caso puntual de "el bot quiso responder pero no tenía
// permiso para escribir" (Tema del foro restringido, bot sin rango de
// admin, etc.) para que se pueda filtrar fácil en los informes.
function esErrorDePermiso(mensajeError) {
  return /not enough rights|CHAT_WRITE_FORBIDDEN|not a member|bot was kicked/i.test(mensajeError || "");
}

export async function registrarChatGrupo({ ctx, pregunta, respuesta, error = null }) {
  const from = ctx.from || {};
  const chat = ctx.chat || {};
  const registro = {
    chatId: chat.id ?? null,
    grupoTitulo: chat.title ?? null,
    temaId: ctx.message?.message_thread_id ?? null,
    userId: from.id ?? null,
    username: from.username ?? null,
    nombre: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
    pregunta,
    respuesta: respuesta ?? null,
    error: error ?? null,
    sinPermiso: esErrorDePermiso(error),
    timestamp: new Date().toISOString(),
  };

  const firestore = ensureInit();
  if (!firestore) {
    console.log("[logsGrupo]", JSON.stringify(registro));
    return;
  }

  try {
    await firestore.collection("logsGrupo").add({
      ...registro,
      creadoEn: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Error guardando log de grupo:", err.message);
    console.log("[logsGrupo fallback]", JSON.stringify(registro));
  }
}

// Lista los temas (topics) donde el bot ya respondió alguna vez, sacado de
// lo que ya tenemos guardado en logsGrupo — así no hace falta ir a buscar
// el ID a mano. Como esos mensajes se enviaron con éxito, el tema estaba
// abierto en ese momento (puede que lo hayan cerrado después, no hay
// garantía, pero es el mejor punto de partida).
export async function listarTemasRecientes(dias = 30) {
  const firestore = ensureInit();
  if (!firestore) return [];

  try {
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
    const snap = await firestore.collection("logsGrupo").where("timestamp", ">=", desde).get();

    const mapa = new Map(); // temaId -> { temaId, cantidad, ultimaPregunta, ultimaFecha }
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.temaId == null || d.error) continue; // solo temas donde SÍ se logró responder
      const key = String(d.temaId);
      const actual = mapa.get(key) || { temaId: d.temaId, cantidad: 0, ultimaPregunta: null, ultimaFecha: null };
      actual.cantidad++;
      if (!actual.ultimaFecha || d.timestamp > actual.ultimaFecha) {
        actual.ultimaFecha = d.timestamp;
        actual.ultimaPregunta = d.pregunta;
      }
      mapa.set(key, actual);
    }

    return [...mapa.values()].sort((a, b) => new Date(b.ultimaFecha) - new Date(a.ultimaFecha));
  } catch (err) {
    console.error("Error listando temas recientes:", err.message);
    return [];
  }
}
