// src/moderacion.js
// Moderación manual del grupo, SOLO por orden del admin (comandos o botones).
// Nada de esto lo dispara Gemini ni un detector automático: el bot expulsa,
// bloquea, mutea o restaura únicamente cuando el admin lo pide.
//
// Requisito en Telegram: el bot tiene que ser admin del grupo con el permiso
// "Banear usuarios" (can_restrict_members).
//
// Acciones:
//   expulsar    -> ban + unban: lo saca, pero puede volver con el link.
//   bloquear    -> ban permanente hasta /desbloquear.
//   desbloquear -> levanta el ban (puede volver a entrar con el link).
//   mutear      -> deja al usuario sin poder escribir (con duración opcional).
//   restaurar   -> levanta ban y/o mute y le devuelve los permisos por
//                  defecto del grupo.
//
// Directorio de usuarios: Telegram no deja que un bot convierta un @usuario en
// ID si no lo conoce, así que se recuerda a quienes escriben en el grupo
// (memoria + Firestore "usuariosGrupo"). Historial en Firestore "moderacion".

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
    console.error("Error inicializando Firebase en moderación:", err.message);
    return null;
  }
}

const MAX_MUTE_MS = 365 * 24 * 60 * 60 * 1000; // Telegram trata >366 días como "para siempre"

// ---------- Directorio de usuarios ----------

const porId = new Map(); // id -> { id, username (minúsculas), nombre }
const porUsername = new Map(); // username (minúsculas) -> info

export function nombreDe(u) {
  if (!u) return "sin nombre";
  return u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ") || `ID ${u.id}`;
}

export function registrarUsuario(from) {
  if (!from || from.is_bot || from.id == null) return;
  const username = (from.username || "").toLowerCase();
  const nombre = nombreDe(from);
  const previo = porId.get(from.id);
  if (previo && previo.username === username && previo.nombre === nombre) return;
  if (previo?.username && previo.username !== username) porUsername.delete(previo.username);
  const info = { id: from.id, username, nombre };
  porId.set(from.id, info);
  if (username) porUsername.set(username, info);
  const firestore = ensureInit();
  if (firestore) {
    firestore
      .collection("usuariosGrupo")
      .doc(String(from.id))
      .set({ ...info, visto: FieldValue.serverTimestamp() }, { merge: true })
      .catch((err) => console.error("Moderación: no pude guardar usuario:", err.message));
  }
}

export function datosConocidos(id) {
  return porId.get(Number(id)) || null;
}

// objetivo = { tipo: "id" | "user", valor } (ver parsearArgs). Devuelve { id, username, nombre } o null.
export async function buscarUsuario(objetivo) {
  if (!objetivo) return null;
  const firestore = ensureInit();
  if (objetivo.tipo === "id") {
    const id = Number(objetivo.valor);
    const conocido = porId.get(id);
    if (conocido) return conocido;
    if (firestore) {
      try {
        const doc = await firestore.collection("usuariosGrupo").doc(String(id)).get();
        if (doc.exists) {
          const d = doc.data();
          return { id, username: d.username || "", nombre: d.nombre || `ID ${id}` };
        }
      } catch {}
    }
    return { id, username: "", nombre: `ID ${id}` };
  }
  const username = String(objetivo.valor).replace(/^@/, "").toLowerCase();
  const conocido = porUsername.get(username);
  if (conocido) return conocido;
  if (firestore) {
    try {
      const snap = await firestore.collection("usuariosGrupo").where("username", "==", username).limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0].data();
        return { id: Number(d.id), username, nombre: d.nombre || `@${username}` };
      }
    } catch (err) {
      console.error("Moderación: error buscando usuario:", err.message);
    }
  }
  return null;
}

// ---------- Parseo de argumentos ----------

// "2h @pepe", "@pepe 30m", "123456789 1d", "2h" (con reply). Duración = número + m/h/d.
export function parsearArgs(texto) {
  const tokens = String(texto || "").trim().split(/\s+/).filter(Boolean);
  let duracionMs = null;
  let objetivo = null;
  for (const t of tokens) {
    const dur = t.match(/^(\d+)\s*(m|min|h|hs|d)$/i);
    if (dur && duracionMs == null) {
      const n = Number(dur[1]);
      const u = dur[2].toLowerCase();
      duracionMs = n * (u.startsWith("m") ? 60_000 : u.startsWith("h") ? 3_600_000 : 86_400_000);
    } else if (/^@\w{3,}$/.test(t) && !objetivo) {
      objetivo = { tipo: "user", valor: t };
    } else if (/^\d{5,}$/.test(t) && !objetivo) {
      objetivo = { tipo: "id", valor: t };
    }
  }
  return { duracionMs, objetivo };
}

export function textoDuracion(ms) {
  if (!ms) return "sin límite de tiempo";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / (60 * 24))} d`;
}

// ---------- Acciones ----------

const SIN_PERMISOS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

const PERMISOS_BASE = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_invite_users: true,
};

let botId = null;

function pistaDeError(err) {
  const d = String(err?.description || err?.message || "");
  if (/not enough rights|CHAT_ADMIN_REQUIRED|need to be an administrator|can't remove chat owner/i.test(d)) {
    return `${d}\nEl bot tiene que ser admin del grupo con el permiso "Banear usuarios".`;
  }
  if (/participant|user not found|USER_NOT_PARTICIPANT/i.test(d)) return `${d}\n(el usuario no está en el grupo)`;
  return d;
}

const registroMemoria = [];

async function registrar(entry) {
  const reg = { ...entry, fecha: new Date().toISOString() };
  registroMemoria.push(reg);
  if (registroMemoria.length > 200) registroMemoria.shift();
  const firestore = ensureInit();
  if (firestore) {
    await firestore
      .collection("moderacion")
      .add({ ...entry, fecha: FieldValue.serverTimestamp() })
      .catch((err) => console.error("Moderación: no pude guardar el historial:", err.message));
  }
}

// protegido(usuario) -> true si es admin del bot (nunca se toca).
// Devuelve { ok, texto }.
export async function aplicarAccion(telegram, { accion, chatId, usuario, por, duracionMs = null }, { protegido = () => false } = {}) {
  const quien = usuario.nombre || `ID ${usuario.id}`;
  try {
    if (botId == null) botId = (await telegram.getMe()).id;
  } catch {}

  const destructiva = ["expulsar", "bloquear", "mutear"].includes(accion);
  if (destructiva) {
    if (usuario.id === botId) return { ok: false, texto: "🛡️ No puedo aplicarme eso a mí mismo." };
    if (protegido(usuario)) return { ok: false, texto: `🛡️ ${quien} es admin del bot: no lo toco.` };
    try {
      const miembro = await telegram.getChatMember(chatId, usuario.id);
      if (["creator", "administrator"].includes(miembro.status)) {
        return { ok: false, texto: `🛡️ ${quien} es admin del grupo. Sacale primero el rol de admin y reintentá.` };
      }
    } catch {
      // no está en el grupo o no se pudo verificar: el ban igual funciona sobre no-miembros
    }
  }

  try {
    let texto;
    if (accion === "expulsar") {
      await telegram.banChatMember(chatId, usuario.id);
      await telegram.unbanChatMember(chatId, usuario.id, { only_if_banned: true });
      texto = `👢 Expulsé a ${quien}. Puede volver a entrar con el link del grupo.`;
    } else if (accion === "bloquear") {
      await telegram.banChatMember(chatId, usuario.id);
      texto = `⛔ Bloqueé a ${quien}. No puede volver a entrar hasta que hagas /desbloquear.`;
    } else if (accion === "desbloquear") {
      await telegram.unbanChatMember(chatId, usuario.id, { only_if_banned: true });
      texto = `✅ Levanté el bloqueo de ${quien}. Puede volver a entrar con el link del grupo.`;
    } else if (accion === "mutear") {
      const dur = duracionMs ? Math.min(duracionMs, MAX_MUTE_MS) : null;
      const extra = { permissions: SIN_PERMISOS, use_independent_chat_permissions: true };
      if (dur) extra.until_date = Math.floor((Date.now() + dur) / 1000);
      await telegram.restrictChatMember(chatId, usuario.id, extra);
      texto = `🔇 Muteé a ${quien} (${textoDuracion(dur)}). Para devolverle los permisos: /restaurar.`;
    } else if (accion === "restaurar") {
      let notas = [];
      try {
        await telegram.unbanChatMember(chatId, usuario.id, { only_if_banned: true });
      } catch (err) {
        notas.push(`No pude levantar un posible bloqueo: ${pistaDeError(err)}`);
      }
      let permisos = PERMISOS_BASE;
      try {
        const chat = await telegram.getChat(chatId);
        if (chat?.permissions) permisos = chat.permissions;
      } catch {}
      try {
        await telegram.restrictChatMember(chatId, usuario.id, { permissions: permisos, use_independent_chat_permissions: true });
      } catch (err) {
        const d = String(err?.description || err?.message || "");
        if (/participant|user not found|USER_NOT_PARTICIPANT/i.test(d)) {
          notas.push("No está en el grupo ahora: cuando vuelva a entrar con el link ya no tiene restricciones.");
        } else {
          throw err;
        }
      }
      texto = `↩️ Restauré a ${quien}: sin bloqueo ni mute, con los permisos normales del grupo.${notas.length ? "\n" + notas.join("\n") : ""}`;
    } else {
      return { ok: false, texto: `Acción desconocida: ${accion}` };
    }
    await registrar({ accion, userId: usuario.id, nombre: quien, username: usuario.username || "", chatId: String(chatId), por: String(por || ""), duracionMs: duracionMs || null });
    return { ok: true, texto };
  } catch (err) {
    console.error(`Moderación (${accion}) falló:`, err.message);
    return { ok: false, texto: `⚠️ No pude ${accion} a ${quien}: ${pistaDeError(err)}` };
  }
}

// Quiénes quedaron con una restricción activa (última acción por usuario que no sea restaurar/desbloquear).
export async function listarModerados(limite = 15) {
  let acciones = [];
  const firestore = ensureInit();
  if (firestore) {
    try {
      const snap = await firestore.collection("moderacion").orderBy("fecha", "desc").limit(200).get();
      acciones = snap.docs.map((d) => {
        const x = d.data();
        return { ...x, fecha: x.fecha?.toDate?.() ?? new Date() };
      });
    } catch (err) {
      console.error("Moderación: error leyendo historial:", err.message);
    }
  }
  if (!acciones.length) acciones = [...registroMemoria].reverse().map((x) => ({ ...x, fecha: new Date(x.fecha) }));

  const vistos = new Set();
  const vigentes = [];
  for (const a of acciones) {
    if (vistos.has(a.userId)) continue;
    vistos.add(a.userId);
    if (["restaurar", "desbloquear"].includes(a.accion)) continue;
    // un mute con duración que ya venció no cuenta como vigente
    if (a.accion === "mutear" && a.duracionMs && a.fecha.getTime() + a.duracionMs < Date.now()) continue;
    vigentes.push(a);
    if (vigentes.length >= limite) break;
  }
  return vigentes;
}

// ---------- Botones ----------

export function tecladoModeracion(chatId, userId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔇 Mutear 24h", callback_data: `mod:m24:${chatId}:${userId}` },
          { text: "👢 Expulsar", callback_data: `mod:x:${chatId}:${userId}` },
        ],
        [
          { text: "⛔ Bloquear", callback_data: `mod:b:${chatId}:${userId}` },
          { text: "Ignorar", callback_data: `mod:ig:${chatId}:${userId}` },
        ],
      ],
    },
  };
}

export function tecladoRestaurar(chatId, userId) {
  return { inline_keyboard: [[{ text: "↩️ Restaurar", callback_data: `mod:r:${chatId}:${userId}` }]] };
}
