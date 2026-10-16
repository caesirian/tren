// src/instalacionesLite.js
// Registro de instalaciones de la webapp Lite (trensarmientoenlinea.com.ar/lite). Pedido de Coco (16/10):
// que quede registro de cuándo un usuario instala la app.
//
// Dos eventos llegan desde la app:
//  - "instalada":       el navegador avisó `appinstalled` (Android/Chrome/Edge/escritorio).
//  - "apertura_app":    la app se abrió en modo pantalla completa (standalone). Es lo único que existe en
//                       iPhone (Safari no emite `appinstalled`) y además mide el uso real de la app instalada.
//
// Privacidad: no se guarda IP, ubicación ni nada identificable. Solo un id aleatorio por instalación (lo genera
// el celular), la plataforma deducida del user-agent y las fechas. Con ese id una misma instalación no se cuenta dos veces.
//
// Colección Firestore: instalacionesLite (un documento por instalación, id = el id aleatorio).

import { FieldValue } from "firebase-admin/firestore";
import { firestoreDb } from "./firestoreStatus.js";

const COLECCION = "instalacionesLite";
const EVENTOS = new Set(["instalada", "apertura_app"]);
const PLATAFORMAS = new Set(["android", "ios", "escritorio", "otro"]);

const txt = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// Límite por IP para que nadie llene la colección (en memoria; se resetea si el servicio reinicia).
const LIMITE_POR_HORA = 20;
const porIp = new Map();
export function excedioLimiteInstalaciones(ip) {
  const ahora = Date.now();
  const lista = (porIp.get(ip) || []).filter((t) => ahora - t < 3600 * 1000);
  lista.push(ahora);
  porIp.set(ip, lista);
  if (porIp.size > 5000) for (const [k, v] of porIp) if (!v.some((t) => ahora - t < 3600 * 1000)) porIp.delete(k);
  return lista.length > LIMITE_POR_HORA;
}

export function normalizarInstalacion(b) {
  if (!b || typeof b !== "object") return null;
  const evento = EVENTOS.has(b.evento) ? b.evento : null;
  const id = typeof b.id === "string" && /^[a-z0-9]{8,32}$/i.test(b.id) ? b.id : null; // id de Firestore: solo alfanumérico
  if (!evento || !id) return null;
  return {
    evento,
    id,
    plataforma: PLATAFORMAS.has(b.plataforma) ? b.plataforma : "otro",
    navegador: txt(b.navegador, 20),
    version: txt(b.version, 20),
  };
}

export async function registrarInstalacion(body) {
  const d = normalizarInstalacion(body);
  if (!d) return { ok: false, error: "payload inválido" };
  const db = firestoreDb();
  if (!db) return { ok: false, error: "Firestore no configurado" };
  const ref = db.collection(COLECCION).doc(d.id);
  const ahora = FieldValue.serverTimestamp();
  const base = { plataforma: d.plataforma, navegador: d.navegador, version: d.version };
  if (d.evento === "instalada") {
    await ref.set({ ...base, instaladaEn: ahora, ultimoEvento: ahora }, { merge: true });
  } else {
    const prev = await ref.get();
    const extra = prev.exists && prev.data().primeraAperturaEn ? {} : { primeraAperturaEn: ahora };
    await ref.set({ ...base, ...extra, ultimaAperturaEn: ahora, ultimoEvento: ahora, aperturas: FieldValue.increment(1) }, { merge: true });
  }
  return { ok: true };
}

const dia = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit" });
const hm = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false });
const cuando = (ts) => (ts?.toDate ? `${dia.format(ts.toDate())} ${hm.format(ts.toDate())}` : "–");

// Resumen para el comando /instalaciones de Telegram (admin). dias: ventana hacia atrás.
export async function textoInstalaciones(dias = 7) {
  const db = firestoreDb();
  if (!db) return "Firestore no está configurado: no puedo leer las instalaciones.";
  dias = Math.min(Math.max(Math.round(dias) || 7, 1), 365);
  const desde = new Date(Date.now() - dias * 86400000);
  const [total, recientes] = await Promise.all([
    db.collection(COLECCION).count().get().then((s) => s.data().count),
    db.collection(COLECCION).where("ultimoEvento", ">=", desde).orderBy("ultimoEvento", "desc").limit(2000).get(),
  ]);
  const filas = recientes.docs.map((d) => d.data());
  const nuevas = filas.filter((f) => (f.instaladaEn || f.primeraAperturaEn)?.toDate?.() >= desde);
  const porPlat = {};
  for (const f of nuevas) porPlat[f.plataforma || "otro"] = (porPlat[f.plataforma || "otro"] || 0) + 1;
  const out = [`📲 App Lite — últimos ${dias} día(s)`];
  out.push(`Instalaciones registradas en total: ${total}`);
  out.push(`Nuevas en el período: ${nuevas.length}${nuevas.length ? " (" + Object.entries(porPlat).map(([k, v]) => `${k}: ${v}`).join(", ") + ")" : ""}`);
  out.push(`Con la app abierta en el período: ${filas.filter((f) => f.ultimaAperturaEn?.toDate?.() >= desde).length}`);
  const ult = nuevas
    .sort((a, b) => (b.instaladaEn || b.primeraAperturaEn).toDate() - (a.instaladaEn || a.primeraAperturaEn).toDate())
    .slice(0, 10);
  if (ult.length) {
    out.push("", "Últimas:");
    for (const f of ult) out.push(`• ${cuando(f.instaladaEn || f.primeraAperturaEn)} · ${f.plataforma || "otro"}${f.navegador ? " · " + f.navegador : ""}${f.instaladaEn ? "" : " (1ª apertura como app)"}`);
  }
  return out.join("\n");
}
