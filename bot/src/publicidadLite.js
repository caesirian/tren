// src/publicidadLite.js
// Métricas de la publicidad de la app Lite (trensarmientoenlinea.com.ar/lite) y del sitio: clics (lo tocaron) por
// anuncio, por origen ("app" o "sitio") y por día, e impresiones (se mostró el banner). En la app una impresión es
// cada vez que aparece el banner; en el sitio, una vez por carga de página cuando al menos la mitad del banner entra
// en pantalla (los banners del sitio están al final o en medio de la página y no todos llegan a verlos).
// Pedido de Coco (19/10): contabilizar los clics, discriminando sitio vs app. 29/10: impresiones y CTR también en el sitio.
//
// Privacidad: igual que instalacionesLite.js — no se guarda IP ni nada identificable; solo contadores diarios.
//
// Colección Firestore: publicidadLite. Un documento por anuncio y día, id = "<anuncio>_<AAAA-MM-DD>" (hora de Argentina),
// con { anuncio, origen, fecha, impresiones, clics, actualizadoEn }. Los del sitio llevan "_sitio_" en el id; los
// documentos anteriores a esta distinción no tienen "origen" y son todos de la app.

import { FieldValue } from "firebase-admin/firestore";
import { firestoreDb } from "./firestoreStatus.js";

const COLECCION = "publicidadLite";
const EVENTOS = new Set(["impresion", "clic"]);
const ORIGENES = new Set(["app", "sitio"]);

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
  const origen = ORIGENES.has(b.origen) ? b.origen : "app"; // sin origen = app (versiones anteriores de Lite)
  return { evento, anuncio, origen };
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
    .doc(d.origen === "sitio" ? `${d.anuncio}_sitio_${fecha}` : `${d.anuncio}_${fecha}`)
    .set({ anuncio: d.anuncio, origen: d.origen, fecha, [campo]: FieldValue.increment(1), actualizadoEn: FieldValue.serverTimestamp() }, { merge: true });
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
  if (!filas.length) return `📢 Publicidad — últimos ${dias} día(s)\nTodavía no hay clics ni impresiones registrados.`;

  const porAnuncio = {}; // anuncio -> { sitio: {clics, impresiones}, app: {clics, impresiones} }
  const porDia = {}; // fecha -> { sitio, app } (clics)
  for (const f of filas) {
    const origen = f.origen === "sitio" ? "sitio" : "app";
    const a = (porAnuncio[f.anuncio] ||= { sitio: { clics: 0, impresiones: 0 }, app: { clics: 0, impresiones: 0 } });
    a[origen].clics += f.clics || 0;
    a[origen].impresiones += f.impresiones || 0;
    const dd = (porDia[f.fecha] ||= { sitio: 0, app: 0 });
    dd[origen] += f.clics || 0;
  }
  const total = (a) => a.sitio.clics + a.app.clics;
  const out = [`📢 Publicidad — últimos ${dias} día(s)`];
  let tSitio = 0, tApp = 0;
  for (const [anuncio, a] of Object.entries(porAnuncio).sort((x, y) => total(y[1]) - total(x[1]))) {
    tSitio += a.sitio.clics;
    tApp += a.app.clics;
    out.push("", `• ${anuncio}: ${total(a)} clic(s)`);
    const det = (o) => (o.impresiones ? ` (${o.impresiones} impresiones · CTR ${pct(o.clics, o.impresiones)})` : "");
    out.push(`   🌐 Sitio: ${a.sitio.clics}${det(a.sitio)}`);
    out.push(`   📱 App: ${a.app.clics}${det(a.app)}`);
  }
  out.push("", `Total: ${tSitio + tApp} clic(s) — 🌐 sitio ${tSitio} · 📱 app ${tApp}`);
  out.push("", "Por día (clics):");
  for (const f of Object.keys(porDia).sort().reverse().slice(0, 10)) {
    const [y, m, d] = f.split("-");
    out.push(`${d}/${m}: 🌐 ${porDia[f].sitio} · 📱 ${porDia[f].app}`);
  }
  return out.join("\n");
}
