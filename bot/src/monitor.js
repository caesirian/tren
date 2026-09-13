// src/monitor.js
// Chequeo periódico disparado por un ping externo (ver README, sección
// "Avisos automáticos"). Compara el estado actual contra el último que
// notificamos, guardado en Firestore para sobrevivir a reinicios del
// servicio, y le avisa al admin por Telegram si hay algo nuevo.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getEstadoServicio } from "./firestoreStatus.js";
import { consultarParoEnVivo } from "./paroSearch.js";

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
    console.error("Error inicializando Firebase en monitor:", err.message);
    return null;
  }
}

async function leerUltimoNotificado() {
  const firestore = ensureInit();
  if (!firestore) return {};
  try {
    const snap = await firestore.collection("botInternal").doc("ultimaNotificacion").get();
    return snap.exists ? snap.data() : {};
  } catch (err) {
    console.error("Error leyendo última notificación:", err.message);
    return {};
  }
}

async function guardarUltimoNotificado(data) {
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection("botInternal").doc("ultimaNotificacion").set(data, { merge: true });
  } catch (err) {
    console.error("Error guardando última notificación:", err.message);
  }
}

export async function chequearYNotificar(bot) {
  if (!process.env.ADMIN_TELEGRAM_ID) {
    return { ok: false, motivo: "falta configurar ADMIN_TELEGRAM_ID" };
  }

  const anterior = await leerUltimoNotificado();
  const cambios = [];

  // 1. ¿Cambió el estado del semáforo (Firestore, cargado a mano en mod.html)?
  const estado = await getEstadoServicio();
  if (estado) {
    const firmaEstado = `${estado.estado}|${estado.mensaje}`;
    if (anterior.firmaEstado && anterior.firmaEstado !== firmaEstado) {
      cambios.push(
        `🔄 Cambió el estado del servicio en el semáforo:\nAntes: ${anterior.etiquetaEstado || "?"}\nAhora: ${estado.etiqueta} — ${estado.mensaje}`
      );
    }
    anterior.firmaEstado = firmaEstado;
    anterior.etiquetaEstado = estado.etiqueta;
  }

  // 2. ¿Hay novedad en la búsqueda de paros/medidas gremiales? (usa su
  // propio caché de 3hs, así que esto no gasta cuota extra de más)
  const paro = await consultarParoEnVivo();
  if (paro?.texto) {
    if (anterior.textoParo && anterior.textoParo !== paro.texto) {
      cambios.push(`📰 Novedad en la búsqueda de paros/medidas gremiales:\n${paro.texto}`);
    }
    anterior.textoParo = paro.texto;
  }

  if (cambios.length) {
    await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, cambios.join("\n\n"));
  }

  await guardarUltimoNotificado(anterior);
  return { ok: true, cambiosNotificados: cambios.length };
}
