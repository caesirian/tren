// src/dailyReport.js
// Informe diario a las 18hs (hora Argentina) con lo que pasó en las
// últimas 24hs: mensajes privados recibidos, mensajes de grupo que el bot
// intentó responder, cuáles tuvieron éxito, y cuáles quiso responder pero
// no tenía permiso. Mismo criterio que se usa cuando piden el informe a
// mano en el chat — ver logsPrivados/logsGrupo en Firestore.
//
// Se dispara desde el mismo ping externo (cron-job.org) que ya golpea
// /internal/check cada 10-15 min (ver monitor.js) — no es un cron propio
// del proceso, así funciona sea cual sea el estado de sueño de Render. La
// fecha del último envío se guarda en Firestore (botInternal/informeDiario)
// para no duplicar el informe si el ping pega varias veces dentro de la
// misma ventana de las 18hs, ni perderlo si el proceso se reinicia.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { RESPUESTA_SIN_DATO } from "./staticData.js";
import { getResumenUltimaHora } from "./complaintTracker.js";

const ZONA = "America/Argentina/Buenos_Aires";
const HORA_ENVIO = 18; // 18:00 hs Argentina

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
    console.error("Error inicializando Firebase en dailyReport:", err.message);
    return null;
  }
}

function fechaArgentinaHoy() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA }).format(new Date()); // YYYY-MM-DD
}

function horaArgentinaActual() {
  return parseInt(
    new Intl.DateTimeFormat("es-AR", { timeZone: ZONA, hour: "numeric", hour12: false }).format(new Date()),
    10
  );
}

async function yaSeEnvioHoy(firestore) {
  try {
    const snap = await firestore.collection("botInternal").doc("informeDiario").get();
    return snap.exists && snap.data().ultimaFecha === fechaArgentinaHoy();
  } catch (err) {
    console.error("Error chequeando último informe diario:", err.message);
    return false;
  }
}

async function marcarEnviadoHoy(firestore) {
  try {
    await firestore
      .collection("botInternal")
      .doc("informeDiario")
      .set({ ultimaFecha: fechaArgentinaHoy() }, { merge: true });
  } catch (err) {
    console.error("Error guardando fecha de informe diario:", err.message);
  }
}

function contarPrivados(docs) {
  const porUsuario = new Map();
  let exitosos = 0;
  let honestos = 0;
  let fallidos = 0;
  for (const d of docs) {
    const quien = d.username ? `@${d.username}` : d.nombre || `ID ${d.userId}`;
    porUsuario.set(quien, (porUsuario.get(quien) || 0) + 1);
    if (d.error) fallidos++;
    else if (d.respuesta === RESPUESTA_SIN_DATO) honestos++;
    else exitosos++;
  }
  return { total: docs.length, porUsuario, exitosos, honestos, fallidos };
}

function contarGrupo(docs) {
  const porGrupo = new Map();
  let exitosos = 0;
  let sinPermiso = 0;
  let fallidos = 0;
  for (const d of docs) {
    const grupo = d.grupoTitulo || `chat ${d.chatId}`;
    porGrupo.set(grupo, (porGrupo.get(grupo) || 0) + 1);
    if (d.sinPermiso) sinPermiso++;
    else if (d.error) fallidos++;
    else exitosos++;
  }
  return { total: docs.length, porGrupo, exitosos, sinPermiso, fallidos };
}

export async function generarInformeTexto() {
  const firestore = ensureInit();
  if (!firestore) {
    return "📊 Informe diario: no se pudo generar, Firestore no está configurado (faltan credenciales).";
  }

  const desde = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const [privadosSnap, grupoSnap] = await Promise.all([
    firestore.collection("logsPrivados").where("creadoEn", ">=", desde).get(),
    firestore.collection("logsGrupo").where("creadoEn", ">=", desde).get(),
  ]);

  const privados = contarPrivados(privadosSnap.docs.map((d) => d.data()));
  const grupo = contarGrupo(grupoSnap.docs.map((d) => d.data()));

  const listaUsuarios = [...privados.porUsuario.entries()].map(([u, n]) => `  · ${u}: ${n}`).join("\n") || "  (nadie)";
  const listaGrupos = [...grupo.porGrupo.entries()].map(([g, n]) => `  · ${g}: ${n}`).join("\n") || "  (sin actividad)";

  const resumenHora = getResumenUltimaHora();
  let bloqueResumenHora;
  if (resumenHora.totalMensajes === 0) {
    bloqueResumenHora = "  (sin actividad en el grupo)";
  } else {
    bloqueResumenHora =
      `  🐢 Demoras/esperas: ${resumenHora.cuentasDemora} cuenta(s) distinta(s)\n` +
      `  🚫 Cancelaciones/paro: ${resumenHora.cuentasCancelacion} cuenta(s) distinta(s)\n` +
      `  ✅ Reportan normalidad: ${resumenHora.cuentasNormalidad} cuenta(s) distinta(s)\n` +
      `  (${resumenHora.totalMensajes} mensajes totales en el grupo en la última hora)`;
  }

  return `📊 Informe diario del bot (últimas 24hs)

🗣️ Última hora en el grupo (cuentas distintas que reportaron algo):
${bloqueResumenHora}

💬 Privados recibidos: ${privados.total}
${listaUsuarios}
  ✅ Respondidos con éxito: ${privados.exitosos}
  🤷 Honesto ("no tengo el dato"): ${privados.honestos}
  ❌ Fallaron (error técnico): ${privados.fallidos}

👥 Grupo — mensajes que intentó responder: ${grupo.total}
${listaGrupos}
  ✅ Respondidos con éxito: ${grupo.exitosos}
  🚫 Quiso responder pero no tenía permiso: ${grupo.sinPermiso}
  ❌ Fallaron (error técnico): ${grupo.fallidos}`;
}

// Llamado desde el mismo ping externo que ya golpea /internal/check.
// Solo envía si son las 18hs Argentina y todavía no se mandó hoy.
export async function chequearYEnviarInformeDiario(bot) {
  if (!process.env.ADMIN_TELEGRAM_ID) return { enviado: false, motivo: "falta ADMIN_TELEGRAM_ID" };
  if (horaArgentinaActual() !== HORA_ENVIO) return { enviado: false, motivo: "no es la hora" };

  const firestore = ensureInit();
  if (!firestore) return { enviado: false, motivo: "sin Firestore" };
  if (await yaSeEnvioHoy(firestore)) return { enviado: false, motivo: "ya enviado hoy" };

  const texto = await generarInformeTexto();
  await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto);
  await marcarEnviadoHoy(firestore);
  return { enviado: true };
}
