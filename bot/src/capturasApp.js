// src/capturasApp.js
// Capturas de pantalla de la app de Trenes Argentinos que suben los usuarios
// al grupo: Gemini (visión) lee el contenido, se guarda en Firestore con la
// fecha/hora del EVENTO (la de la captura, no la de subida) y se coteja
// automáticamente contra los datos en vivo del proxy (barrido de Sarmiento).
// Todo en silencio: al grupo no se publica nada; el resultado le llega solo
// al admin por privado.
//
// Las capturas NO son fuente de verdad del bot (las sube cualquiera): sirven
// para medir cuánto coincide la app con lo que devuelve el proxy.

import { GoogleGenAI } from "@google/genai";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { barridoEstructurado, serviciosSarmiento, textoBarrido, datosServicio, hora } from "./appTrenes.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash-lite";
const COLECCION = "capturasApp";
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
const EDAD_MAX_COTEJO_MIN = 15; // una captura más vieja no es comparable con el estado "ahora"

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
    console.error("Error inicializando Firebase en capturasApp:", err.message);
    return null;
  }
}

let recientes = []; // { imagenHash, fileUniqueId, timestamp } — respaldo sin Firestore y para carreras
const limpiarJSON = (t) => t.replace(/```json|```/g, "").trim();

export async function capturaYaProcesada({ imagenHash, fileUniqueId }) {
  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  recientes = recientes.filter((c) => c.timestamp >= desde);
  if (recientes.some((c) => (imagenHash && c.imagenHash === imagenHash) || (fileUniqueId && c.fileUniqueId === fileUniqueId))) return true;
  const firestore = ensureInit();
  if (!firestore) return false;
  try {
    if (imagenHash) {
      const snap = await firestore.collection(COLECCION).where("imagenHash", "==", imagenHash).limit(1).get();
      if (!snap.empty) return true;
    }
  } catch (err) {
    console.error("Error chequeando capturas repetidas:", err.message);
  }
  return false;
}

export function recordarCaptura({ imagenHash, fileUniqueId }) {
  recientes.push({ imagenHash, fileUniqueId, timestamp: new Date().toISOString() });
}

const PROMPT = `
Esta imagen puede ser una CAPTURA DE PANTALLA de la app (o del sitio) de Trenes Argentinos / SOFSE que muestra estado del servicio, arribos/horarios de una estación, o alertas.
Devolvé SOLO un JSON (sin markdown) con esta forma exacta:
{
  "esCapturaAppTrenes": true o false,
  "tipo": "arribos" | "alerta" | "estado_servicio" | "otro",
  "estacion": "nombre de la estación que se está viendo" o null,
  "ramal": "ramal o línea" o null,
  "horaCaptura": "HH:MM" (24hs) leída del reloj del celular (barra superior) o de la hora de actualización de la app, o null,
  "fechaCaptura": "DD/MM" si la captura muestra la fecha, o null,
  "alertaTexto": "texto completo de cualquier banner/alerta/aviso visible en la app" o null,
  "servicios": [
    { "horaProgramada": "HH:MM" o null, "horaEstimada": "HH:MM" o null, "destino": "..." o null,
      "estado": "texto de estado tal como se ve (En andén, Partió, Cancelado, Demorado, etc.)" o null,
      "demoraMin": número o null, "cancelado": true o false, "leyenda": "texto extra del servicio" o null }
  ],
  "textoDetectado": "todo el texto relevante que se lee, resumido"
}
Reglas: esCapturaAppTrenes=false si es una foto común, meme, publicidad, comunicado gráfico, captura de otra app o cualquier cosa que no sea la app/sitio de Trenes Argentinos. No inventes datos: si algo no se ve, null.
`.trim();

export async function analizarCapturaApp(base64Data, mimeType = "image/jpeg") {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64Data } }] }],
  });
  const texto = limpiarJSON(response.text.trim());
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error("No pude interpretar la lectura de la captura como JSON: " + texto.slice(0, 200));
  }
}

// Fecha/hora del evento: la de la captura (reloj del celular) y no la de
// subida. Sin fecha en la captura se asume el día de la subida, o el día
// anterior si esa hora queda en el futuro.
export function calcularEventoEn(horaCaptura, fechaCaptura, subidoEn) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(horaCaptura || "");
  if (!m) return { eventoEn: subidoEn, origen: "subida" };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return { eventoEn: subidoEn, origen: "subida" };
  const ar = new Date(subidoEn.getTime() - AR_OFFSET_MS); // campos UTC = reloj de Buenos Aires
  let anio = ar.getUTCFullYear();
  let mes = ar.getUTCMonth();
  let dia = ar.getUTCDate();
  const f = /^(\d{1,2})\/(\d{1,2})$/.exec(fechaCaptura || "");
  if (f) {
    dia = Number(f[1]);
    mes = Number(f[2]) - 1;
  }
  let ms = Date.UTC(anio, mes, dia, hh, mm) + AR_OFFSET_MS;
  if (!f && ms > subidoEn.getTime() + 10 * 60 * 1000) ms -= 24 * 60 * 60 * 1000;
  if (f && ms > subidoEn.getTime() + 24 * 60 * 60 * 1000) ms = Date.UTC(anio - 1, mes, dia, hh, mm) + AR_OFFSET_MS;
  return { eventoEn: new Date(ms), origen: f ? "captura (fecha y hora)" : "captura (hora)" };
}

export async function guardarCaptura(datos, meta) {
  const registro = {
    ...datos,
    servicios: Array.isArray(datos.servicios) ? datos.servicios : [],
    eventoEn: meta.eventoEn.toISOString(),
    eventoOrigen: meta.eventoOrigen,
    subidoEn: meta.subidoEn.toISOString(),
    subidoPor: meta.quien,
    userId: meta.userId ?? null,
    chatId: meta.chatId ?? null,
    threadId: meta.threadId ?? null,
    imagenHash: meta.imagenHash ?? null,
    fileUniqueId: meta.fileUniqueId ?? null,
    fileId: meta.fileId ?? null,
  };
  const firestore = ensureInit();
  if (!firestore) {
    console.log("[capturasApp fallback]", JSON.stringify(registro).slice(0, 500));
    return { id: null };
  }
  try {
    const ref = await firestore.collection(COLECCION).add({ ...registro, creadoEn: FieldValue.serverTimestamp() });
    return { id: ref.id };
  } catch (err) {
    console.error("Error guardando captura en Firestore:", err.message);
    return { id: null };
  }
}

export async function guardarCotejo(id, cotejo) {
  const firestore = ensureInit();
  if (!firestore || !id) return;
  try {
    await firestore.collection(COLECCION).doc(id).update({ cotejo, cotejadoEn: new Date().toISOString() });
  } catch (err) {
    console.error("Error guardando cotejo de captura:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Cotejo contra el proxy
// ---------------------------------------------------------------------------
const sinAcentos = (t) => (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const minutosDelDia = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const difMin = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
};

function buscarEnProxy(sv, pool, estacion) {
  const est = sinAcentos(estacion);
  const dest = sinAcentos(sv.destino);
  const prog = minutosDelDia(sv.horaProgramada) ?? minutosDelDia(sv.horaEstimada);
  if (prog == null) return null;
  return (
    pool.find((item) => {
      const d = datosServicio(item);
      if (est && !sinAcentos(item.est.nombre).includes(est) && !est.includes(sinAcentos(item.est.nombre))) return false;
      if (dest && d.destino && !sinAcentos(d.destino).includes(dest) && !dest.includes(sinAcentos(d.destino))) return false;
      const pProxy = minutosDelDia(hora(d.prog));
      return pProxy != null && difMin(pProxy, prog) <= 2;
    }) || null
  );
}

export async function cotejarCaptura(datos, eventoEn, ahora = new Date()) {
  const edadMin = Math.round((ahora - eventoEn) / 60000);
  const barrido = await barridoEstructurado();
  const lineas = [];

  // Pool de comparación: si la estación de la captura no está entre las del
  // barrido, se consulta esa estación puntualmente al proxy.
  const est = sinAcentos(datos.estacion);
  let pool = barrido.todos;
  if (est && !barrido.todos.some((i) => sinAcentos(i.est.nombre).includes(est) || est.includes(sinAcentos(i.est.nombre)))) {
    try {
      const extra = await serviciosSarmiento(datos.estacion);
      pool = barrido.todos.concat(extra.servicios);
      if (!extra.servicios.length) lineas.push(`ℹ️ El proxy no devolvió servicios de Sarmiento para "${datos.estacion}".`);
    } catch (err) {
      lineas.push(`ℹ️ No pude consultar la estación "${datos.estacion}" en el proxy: ${err.message}`);
    }
  }
  let coinciden = 0;
  let discrepancias = 0;
  let noEncontrados = 0;

  for (const sv of datos.servicios || []) {
    const etiqueta = `${sv.horaProgramada || sv.horaEstimada || "--:--"} → ${sv.destino || "?"}`;
    const item = buscarEnProxy(sv, pool, datos.estacion);
    if (!item) {
      noEncontrados++;
      lineas.push(`❓ ${etiqueta}: no lo encontré en el proxy`);
      continue;
    }
    const d = datosServicio(item);
    const problemas = [];
    const proxyCancel = !!d.s.cancelacion;
    if (!!sv.cancelado !== proxyCancel) problemas.push(sv.cancelado ? "la captura dice CANCELADO y el proxy no informa cancelación" : "el proxy informa cancelación y la captura no");
    if (sv.demoraMin != null && d.demora != null && Math.abs(sv.demoraMin - d.demora) > 3) problemas.push(`demora: captura ${sv.demoraMin} min vs proxy ${d.demora} min`);
    if (sv.leyenda && !d.s.leyenda) problemas.push(`la captura tiene leyenda ("${String(sv.leyenda).slice(0, 60)}") y el proxy no`);
    if (problemas.length) {
      discrepancias++;
      lineas.push(`⚠️ ${etiqueta}: ${problemas.join("; ")}`);
    } else {
      coinciden++;
      lineas.push(`✅ ${etiqueta}: coincide${d.demora != null ? ` (proxy ${d.demora >= 0 ? "+" : ""}${d.demora} min)` : ""}`);
    }
  }

  // ¿La alerta/leyenda que se ve en la app llega por el proxy?
  const hayAlertaEnCaptura = !!(datos.alertaTexto || (datos.servicios || []).some((s) => s.leyenda || s.cancelado));
  const proxyTieneTexto = pool.some((item) => item.r?.servicio?.cancelacion || item.r?.servicio?.leyenda);
  let alertaEnProxy = null;
  if (hayAlertaEnCaptura) {
    alertaEnProxy = proxyTieneTexto;
    lineas.push(
      proxyTieneTexto
        ? "📢 La captura muestra una alerta/cancelación y el proxy también trae cancelaciones o leyendas (ver barrido)."
        : "📢 La captura muestra una alerta/cancelación pero el proxy NO trae ninguna cancelación ni leyenda en este momento: esa info no está llegando por este endpoint."
    );
  }

  return {
    edadMin,
    vieja: edadMin > EDAD_MAX_COTEJO_MIN,
    coinciden,
    discrepancias,
    noEncontrados,
    alertaEnCaptura: hayAlertaEnCaptura,
    alertaEnProxy,
    serviciosProxy: barrido.todos.length,
    anormalesProxy: barrido.anormales.length,
    erroresProxy: barrido.errores.length,
    lineas,
    textoBarrido: textoBarrido(barrido),
  };
}

export function armarReporte({ datos, quien, chatTitle, threadId, eventoEn, eventoOrigen, subidoEn, cotejo, guardadoId }) {
  const fmt = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const serv = (datos.servicios || []).slice(0, 10).map((s) => `  • ${s.horaProgramada || "--:--"}${s.horaEstimada ? ` (est ${s.horaEstimada})` : ""} → ${s.destino || "?"} | ${s.estado || "s/d"}${s.demoraMin != null ? ` | ${s.demoraMin} min` : ""}${s.cancelado ? " | CANCELADO" : ""}${s.leyenda ? ` | "${String(s.leyenda).slice(0, 60)}"` : ""}`);
  let t = `📱 Captura de la app de Trenes Argentinos\n👤 ${quien} en «${chatTitle || "grupo"}»${threadId ? ` (tema ${threadId})` : ""}\n`;
  t += `🕒 Evento: ${fmt(eventoEn)} (${eventoOrigen}) · subida ${fmt(subidoEn)}\n`;
  t += `📍 ${datos.estacion || "estación s/d"}${datos.ramal ? ` · ${datos.ramal}` : ""} · tipo: ${datos.tipo || "s/d"}\n`;
  if (datos.alertaTexto) t += `📢 Alerta en la app: "${String(datos.alertaTexto).slice(0, 400)}"\n`;
  t += `Servicios leídos: ${(datos.servicios || []).length}${serv.length ? "\n" + serv.join("\n") : ""}\n`;
  t += guardadoId ? `💾 Guardada en Firestore (capturasApp/${guardadoId}).\n` : "💾 No pude guardarla en Firestore (revisar logs).\n";
  if (cotejo) {
    t += `\n🔎 Cotejo contra el proxy (ahora): ✅ ${cotejo.coinciden} · ⚠️ ${cotejo.discrepancias} · ❓ ${cotejo.noEncontrados}\n`;
    if (cotejo.vieja) t += `⏳ La captura tiene ${cotejo.edadMin} min: el proxy muestra el estado de AHORA, así que las diferencias pueden ser por el paso del tiempo.\n`;
    t += cotejo.lineas.length ? cotejo.lineas.join("\n") + "\n" : "(la captura no trae servicios para comparar uno a uno)\n";
    t += `\n${cotejo.textoBarrido}`;
  }
  return t;
}
