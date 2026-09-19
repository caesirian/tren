// src/silencio.js
// Modo silencio (/silencio y /hablar, solo admin): el bot sigue funcionando
// igual por dentro (procesa preguntas, arma respuestas, guarda logs, lee
// comunicados) pero NO publica nada en grupos: lo que habría escrito le llega
// al admin por privado, para monitorear su desempeño sin ruido en el grupo.
//
// Cómo funciona: se intercepta Telegram.prototype.callApi (Telegraf crea una
// instancia nueva de Telegram por cada update, así que hay que parchear el
// prototipo y no bot.telegram, o ctx.reply se saltearía el filtro). Todo envío cuyo destino es
// un grupo (chat_id negativo) se redirige al admin con contexto (quién
// preguntó y qué). Los chats privados no se tocan. Excepción: los comandos
// del propio admin (ej. /decir) siguen publicando en el grupo, porque son
// una orden explícita suya.
//
// El estado se guarda en Firestore (configBot/silencio) para sobrevivir a
// reinicios de Render; sin Firestore queda solo en memoria.

import { AsyncLocalStorage } from "node:async_hooks";
import { Telegram } from "telegraf";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const als = new AsyncLocalStorage();
let silenciado = false;
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
    console.error("Error inicializando Firebase en silencio:", err.message);
    return null;
  }
}

export function estaSilenciado() {
  return silenciado;
}

export async function cargarSilencio() {
  const firestore = ensureInit();
  if (!firestore) return silenciado;
  try {
    const doc = await firestore.collection("configBot").doc("silencio").get();
    silenciado = doc.exists && doc.data().activo === true;
    if (silenciado) console.log("Modo silencio ACTIVO (restaurado desde Firestore)");
  } catch (err) {
    console.error("Error cargando modo silencio:", err.message);
  }
  return silenciado;
}

export async function setSilencio(activo, quien) {
  silenciado = !!activo;
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection("configBot").doc("silencio").set({ activo: silenciado, cambiadoPor: quien || null, cambiadoEn: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.error("Error guardando modo silencio:", err.message);
  }
}

const ENVIOS_A_DESVIAR = new Set([
  "sendPhoto", "sendDocument", "sendVideo", "sendAudio", "sendVoice", "sendAnimation", "sendSticker",
  "sendPoll", "sendVideoNote", "sendMediaGroup", "sendLocation", "sendVenue", "sendContact", "forwardMessage", "copyMessage",
]);
const ACCIONES_A_TRAGAR = new Set(["sendChatAction", "setMessageReaction", "editMessageText", "editMessageReplyMarkup", "deleteMessage", "pinChatMessage"]);

const esGrupo = (chatId) => String(chatId ?? "").startsWith("-");

export function instalarSilencio(bot) {
  // Contexto por update: así el desvío sabe quién preguntó y qué.
  bot.use((ctx, next) => {
    const texto = ctx.message?.text || "";
    const store = {
      ctx,
      esComandoAdmin: !!process.env.ADMIN_TELEGRAM_ID && String(ctx.from?.id) === String(process.env.ADMIN_TELEGRAM_ID) && texto.startsWith("/"),
    };
    return als.run(store, next);
  });

  if (Telegram.prototype.__silencioInstalado) return;
  const original = Telegram.prototype.callApi;

  async function avisarAdmin(texto) {
    const admin = process.env.ADMIN_TELEGRAM_ID;
    if (!admin) {
      console.log("[silencio] sin ADMIN_TELEGRAM_ID, se descarta:", texto.slice(0, 120));
      return;
    }
    try {
      await original.call(bot.telegram, "sendMessage", { chat_id: admin, text: texto.slice(0, 4000) });
    } catch (err) {
      console.error("Error mandando al admin lo desviado por silencio:", err.message);
    }
  }

  function encabezado(payload) {
    const store = als.getStore();
    const c = store?.ctx;
    const grupo = c?.chat?.title || `chat ${payload.chat_id}`;
    const tema = payload.message_thread_id ?? c?.message?.message_thread_id;
    const quien = c?.from ? (c.from.username ? `@${c.from.username}` : [c.from.first_name, c.from.last_name].filter(Boolean).join(" ") || `ID ${c.from.id}`) : null;
    const pregunta = c?.message?.text;
    let h = `🔇 [Silencio] Habría publicado en «${grupo}»${tema ? ` (tema ${tema})` : ""}`;
    if (quien && pregunta) h += `\n👤 ${quien} escribió: "${pregunta.slice(0, 300)}"`;
    else h += `\n(mensaje automático, sin pregunta asociada)`;
    return h;
  }

  Telegram.prototype.__silencioInstalado = true;
  Telegram.prototype.callApi = async function (method, payload = {}, ...resto) {
    if (silenciado && esGrupo(payload.chat_id) && !als.getStore()?.esComandoAdmin) {
      if (method === "sendMessage") {
        await avisarAdmin(`${encabezado(payload)}\n\n💬 Respuesta:\n${payload.text}`);
        return { message_id: 0, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: "supergroup" }, text: payload.text };
      }
      if (ENVIOS_A_DESVIAR.has(method)) {
        await avisarAdmin(`${encabezado(payload)}\n\n(envío de tipo ${method}, no se muestra el contenido)`);
        return { message_id: 0, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: "supergroup" } };
      }
      if (ACCIONES_A_TRAGAR.has(method)) return true;
    }
    return original.call(this, method, payload, ...resto);
  };
}
