// src/pushAuto.js
// Push automática a los suscriptores del sitio (OneSignal) cuando:
//  - cambia el semáforo (normal / demoras / paro), venga de quien venga
//    (/estado, botón "✅ Tomar", semáforo automático), o
//  - se suma una alerta complementaria (obra programada, cese de servicio, etc.).
// El bot sigue sin escribir el semáforo por su cuenta desde las propuestas:
// la push sale cuando el cambio YA se publicó en el sitio.
//
// Anti-spam: la misma push no se repite en 2 h; entre dos pushes no urgentes
// pasan al menos 10 min; "paro" es urgente (se salta el intervalo). El semáforo
// automático por demoras NO manda push salvo que haya cancelaciones
// (PUSH_AUTO_DEMORAS=true lo habilita siempre). "Normalizado" solo se manda si
// antes se avisó un incidente (últimas 24 h). Se apaga con /pushauto off o
// PUSH_AUTO=false. Cada envío automático se avisa por privado al admin.

import { firestoreDb } from "./firestoreStatus.js";

const APP_ID = "114f6665-eede-42d0-90ad-4d6480f10c76";
const URL_SITIO = "https://trensarmientoenlinea.com.ar";
const MIN = 60 * 1000;
const MISMA_PUSH_MS = 120 * MIN;
const ENTRE_PUSHES_MS = 10 * MIN;
const INCIDENTE_VIGENTE_MS = 24 * 60 * MIN;
const MAX_MENSAJE = 178;

let activo = String(process.env.PUSH_AUTO ?? "true").trim().toLowerCase() !== "false";
let ultimoId = null;
let memoria = { ultimoEnvioMs: 0, ultimaClave: null, ultimaClaveMs: 0, incidenteMs: 0 };

export const pushAutoActivo = () => activo;
export const ultimaPushId = () => ultimoId;

export async function cargarPushAuto() {
  const fs = firestoreDb();
  if (!fs) return activo;
  try {
    const doc = await fs.collection("configBot").doc("pushAuto").get();
    if (doc.exists) {
      const d = doc.data();
      if (typeof d.activo === "boolean") activo = d.activo;
      for (const k of Object.keys(memoria)) if (d[k] !== undefined) memoria[k] = d[k];
    }
    console.log(`Push automática: ${activo ? "ACTIVA" : "apagada"}`);
  } catch (err) {
    console.error("Error cargando push automática:", err.message);
  }
  return activo;
}

async function persistir(extra = {}) {
  const fs = firestoreDb();
  if (!fs) return;
  try {
    await fs.collection("configBot").doc("pushAuto").set({ activo, ...memoria, ...extra }, { merge: true });
  } catch (err) {
    console.error("Error guardando push automática:", err.message);
  }
}

export async function setPushAuto(valor, quien) {
  activo = !!valor;
  await persistir({ cambiadoPor: quien || null, cambiadoEn: new Date().toISOString() });
}

const recortar = (t, n = MAX_MENSAJE) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
};

// Envío directo a OneSignal (keys nuevas os_v2_ → esquema "Key"; viejas → "Basic").
export async function enviarPush({ titulo, mensaje, url }) {
  const key = process.env.ONESIGNAL_REST_API_KEY;
  if (!key) throw new Error("Falta ONESIGNAL_REST_API_KEY en el bot.");
  const v2 = key.startsWith("os_v2_");
  const r = await fetch(v2 ? "https://api.onesignal.com/notifications?c=push" : "https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${v2 ? "Key" : "Basic"} ${key}` },
    body: JSON.stringify({
      app_id: APP_ID,
      included_segments: [v2 ? "Total Subscriptions" : "All"],
      headings: { es: titulo, en: titulo },
      contents: { es: mensaje, en: mensaje },
      url: url || URL_SITIO,
      chrome_web_icon: `${URL_SITIO}/logo.png`,
      firefox_icon: `${URL_SITIO}/logo.png`,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const texto = await r.text();
  let data = null;
  try { data = JSON.parse(texto); } catch {}
  if (!r.ok || !data?.id) {
    const detalle = data ? JSON.stringify(data.errors || data) : texto.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`OneSignal HTTP ${r.status} — ${detalle}`);
  }
  ultimoId = data.id;
  return data;
}

// ---- Decisión (pura, testeable) ------------------------------------------

const esEditorBot = (e) => String(e || "") === "Bot automático";

// Devuelve { titulo, mensaje, urgente, incidente, clave } o null (no mandar).
export function decidirPushEstado({ anterior, estado, mensaje, editor }, { ahoraMs = Date.now(), incidenteMs = 0, demorasAuto = false } = {}) {
  const prev = anterior || "normal";
  if (prev === estado) return null; // solo cambios de color del semáforo

  if (estado === "normal") {
    // Solo se avisa la normalización si antes se avisó un incidente.
    if (!incidenteMs || ahoraMs - incidenteMs > INCIDENTE_VIGENTE_MS) return null;
    return { titulo: "✅ Servicio normalizado", mensaje: "El servicio del Sarmiento se normalizó.", urgente: false, incidente: false, clave: "normal" };
  }

  const msg = recortar(mensaje) || (estado === "paro" ? "Servicio interrumpido. Más info en el sitio." : "Servicio con demoras. Más info en el sitio.");
  if (estado === "paro") {
    return { titulo: "🚨 Servicio interrumpido", mensaje: msg, urgente: true, incidente: true, clave: `paro|${msg.toLowerCase().slice(0, 60)}` };
  }
  if (estado === "modificado") {
    // El semáforo automático solo avisa si hay cancelaciones (o si se habilita).
    if (esEditorBot(editor) && !demorasAuto && !/cancelaci/i.test(msg)) return null;
    const hayCancel = /cancelaci/i.test(msg);
    return { titulo: hayCancel ? "⚠️ Cancelaciones y demoras" : "⚠️ Servicio con demoras", mensaje: msg, urgente: false, incidente: true, clave: `modificado|${msg.toLowerCase().slice(0, 60)}` };
  }
  return null;
}

// Aplica anti-spam. Devuelve null si se puede enviar, o el motivo de descarte.
export function motivoDescarte(dec, { ahoraMs = Date.now(), ultimoEnvioMs = 0, ultimaClave = null, ultimaClaveMs = 0 } = {}) {
  if (dec.clave === ultimaClave && ahoraMs - ultimaClaveMs < MISMA_PUSH_MS) return "misma push enviada hace menos de 2 h";
  if (!dec.urgente && ahoraMs - ultimoEnvioMs < ENTRE_PUSHES_MS) return "otra push salió hace menos de 10 min";
  return null;
}

// ---- Envío automático ----------------------------------------------------

let avisarAdmin = async () => {};

async function despachar(dec, origen) {
  if (!activo) return { enviado: false, motivo: "push automática apagada" };
  const ahoraMs = Date.now();
  const motivo = motivoDescarte(dec, { ahoraMs, ...memoria });
  if (motivo) {
    console.log(`Push automática descartada (${origen}): ${motivo} — "${dec.titulo}"`);
    return { enviado: false, motivo };
  }
  try {
    const data = await enviarPush({ titulo: dec.titulo, mensaje: dec.mensaje, url: dec.url });
    memoria.ultimoEnvioMs = ahoraMs;
    memoria.ultimaClave = dec.clave;
    memoria.ultimaClaveMs = ahoraMs;
    if (dec.incidente) memoria.incidenteMs = ahoraMs;
    else if (dec.clave === "normal") memoria.incidenteMs = 0;
    await persistir();
    await avisarAdmin(`📣 Push automática enviada (${origen})\n"${dec.titulo}"\n${dec.mensaje}\n\nID: ${data.id} · Ver entrega: /pushestado\nPara frenar las automáticas: /pushauto off`);
    return { enviado: true, id: data.id };
  } catch (err) {
    console.error(`Error en push automática (${origen}):`, err.message);
    await avisarAdmin(`⚠️ No pude mandar la push automática (${origen}): ${err.message}\n"${dec.titulo}" — ${dec.mensaje}\nSi querés mandarla igual: /push ${dec.titulo} | ${dec.mensaje}`);
    return { enviado: false, motivo: err.message };
  }
}

export async function pushPorCambioEstado({ anterior, estado, mensaje, editor }) {
  const dec = decidirPushEstado(
    { anterior, estado, mensaje, editor },
    { incidenteMs: memoria.incidenteMs, demorasAuto: String(process.env.PUSH_AUTO_DEMORAS || "").toLowerCase() === "true" }
  );
  if (!dec) return { enviado: false, motivo: "sin push para este cambio" };
  return despachar(dec, `semáforo → ${estado}${editor ? ` · ${editor}` : ""}`);
}

// opts: { titulo, mensaje, origen } — alertas complementarias (obras, ceses, avisos).
export async function pushPorAlerta({ titulo, mensaje, origen }) {
  const msg = recortar(mensaje);
  if (!msg) return { enviado: false, motivo: "alerta vacía" };
  return despachar({ titulo: titulo || "📢 Aviso de servicio", mensaje: msg, urgente: false, incidente: false, clave: `alerta|${msg.toLowerCase().slice(0, 60)}` }, origen || "alerta");
}

export function iniciarPushAuto({ notificarAdmin } = {}) {
  if (notificarAdmin) avisarAdmin = notificarAdmin;
}
