// src/publicidadLite.js
// Métricas de la publicidad de la app Lite (trensarmientoenlinea.com.ar/lite): impresiones (se mostró el banner)
// y clics (lo tocaron), por anuncio y por día. Pedido de Coco (19/10): contabilizar los clics.
//
// Privacidad: igual que instalacionesLite.js — no se guarda IP ni nada identificable; solo contadores diarios.
//
// Colección Firestore: publicidadLite. Un documento por anuncio y día, id = "<anuncio>_<AAAA-MM-DD>" (hora de Argentina),
// con { anuncio, fecha, impresiones, clics, actualizadoEn }.

import { FieldValue } from "firebase-admin/firestore";
import { firestoreDb } from "./firestoreStatus.js";

const COLECCION = "publicidadLite";
const EVENTOS = new Set(["impresion", "clic"]);

const fechaAR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" });
const hoyAR = (d = new Date()) => fechaAR.format(d); // AAAA-MM-DD

// Límite por IP (en memoria; se resetea si el servicio reinicia). Más holgado que el de instalaciones: hay una impresión por minuto.
const LIMITE_POR_HORA = 300;
const porIp = new Map();
export function excedioLimitePublicidad(ip) {
  const ahora = Date.now();
  const lista = (porIp.get(ip) || []).filter((t) => ahora - t < 3600 * 1000);
  lista.push(ahora);
  porIp.set(ip, lista);
  if (porIp.size > 5000) for (const [k, v] of porIp) if (!v.some((t) => ahora - t < 3600 * 1000)) porIp.delete(k);
  return lista.length > LIMITE_POR_HORA;
}

export function normalizarEventoPublicidad(b) {
  if (!b || typeof b !== "object") return null;
  const evento = EVENTOS.has(b.evento) ? b.evento : null;
  const anuncio = typeof b.anuncio === "string" && /^[a-z0-9-]{2,40}$/.test(b.anuncio) ? b.anuncio : null;
  if (!evento || !anuncio) return null;
  return { evento, anuncio };
}

export async function registrarEventoPublicidad(body) {
  const d = normalizarEventoPublicidad(body);
  if (!d) return { ok: false, error: "payload inválido" };
  const db = firestoreDb();
  if (!db) return { ok: false, error: "Firestore no configurado" };
  const fecha = hoyAR();
  const campo = d.evento === "clic" ? "clics" : "impresiones";
  await db
    .collection(COLECCION)
    .doc(`${d.anuncio}_${fecha}`)
    .set({ anuncio: d.anuncio, fecha, [campo]: FieldValue.increment(1), actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
}

const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1).replace(".", ",") + "%" : "–");

// Resumen para el comando /publicidad de Telegram (admin). dias: ventana hacia atrás (incluye hoy).
export async function textoPublicidad(dias = 7) {
  const db = firestoreDb();
  if (!db) return "Firestore no está configurado: no puedo leer la publicidad.";
  dias = Math.min(Math.max(Math.round(dias) || 7, 1), 365);
  const desde = hoyAR(new Date(Date.now() - (dias - 1) * 86400000));
  const snap = await db.collection(COLECCION).where("fecha", ">=", desde).get();
  const filas = snap.docs.map((d) => d.data());
  if (!filas.length) return `📢 Publicidad Lite — últimos ${dias} día(s)\nTodavía no hay impresiones ni clics registrados.`;

  const porAnuncio = {};
  const porDia = {};
  for (const f of filas) {
    const a = (porAnuncio[f.anuncio] ||= { impresiones: 0, clics: 0 });
    a.impresiones += f.impresiones || 0;
    a.clics += f.clics || 0;
    const dd = (porDia[f.fecha] ||= { impresiones: 0, clics: 0 });
    dd.impresiones += f.impresiones || 0;
    dd.clics += f.clics || 0;
  }
  const out = [`📢 Publicidad Lite — últimos ${dias} día(s)`];
  for (const [anuncio, v] of Object.entries(porAnuncio).sort((x, y) => y[1].clics - x[1].clics)) {
    out.push(`• ${anuncio}: ${v.clics} clic(s) · ${v.impresiones} impresiones · CTR ${pct(v.clics, v.impresiones)}`);
  }
  const dias7 = Object.keys(porDia).sort().reverse().slice(0, 10);
  out.push("", "Por día:");
  for (const f of dias7) {
    const [y, m, d] = f.split("-");
    out.push(`${d}/${m}: ${porDia[f].clics} clic(s) / ${porDia[f].impresiones} impresiones`);
  }
  return out.join("\n");
}
