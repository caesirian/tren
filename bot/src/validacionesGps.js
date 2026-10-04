// src/validacionesGps.js
// Registro de la "Validación de Usuario" del mapa de formaciones del sitio (botón que compara el
// GPS del celular del pasajero con la posición de la formación que eligió). Pedido de Coco (4/10):
// dejar registro de cada validación para medir la precisión y hacer seguimiento.
//
// Privacidad: el navegador NO manda las coordenadas del usuario. La comparación se hace en el
// celular y acá solo llegan datos derivados (posición proyectada sobre el ramal en "estaciones",
// distancia al eje, precisión del GPS, resultado y motivo). Nada que permita ubicar a una persona.
//
// Colección Firestore: validacionesGPS (una fila por intento). Se escribe con el service account del
// bot, así no hace falta abrir reglas de escritura al público.

import { FieldValue } from "firebase-admin/firestore";
import { firestoreDb } from "./firestoreStatus.js";

const COLECCION = "validacionesGPS";

const MOTIVOS = new Set(["ok", "sin_permiso", "gps_no_disponible", "tiempo_agotado", "sin_geolocalizacion", "impreciso", "lejos_del_ramal", "distinto_tramo", "dato_invalido"]);
const FUENTES = new Set(["gps", "estimada"]);

const num = (v, min, max, dec = 2) => {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n) || n < min || n > max) return null;
  const f = 10 ** dec;
  return Math.round(n * f) / f;
};
const txt = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// Limita por IP para que nadie llene la colección (en memoria; se resetea si el servicio reinicia).
const LIMITE_POR_HORA = 30;
const porIp = new Map(); // ip -> [timestamps]
export function excedioLimiteValidaciones(ip) {
  const ahora = Date.now();
  const lista = (porIp.get(ip) || []).filter((t) => ahora - t < 3600 * 1000);
  lista.push(ahora);
  porIp.set(ip, lista);
  if (porIp.size > 5000) for (const [k, v] of porIp) if (!v.some((t) => ahora - t < 3600 * 1000)) porIp.delete(k);
  return lista.length > LIMITE_POR_HORA;
}

// Valida y normaliza lo que manda el sitio. Devuelve el documento a guardar o null si no sirve.
export function normalizarValidacion(b) {
  if (!b || typeof b !== "object") return null;
  const resultado = b.resultado === "ok" ? "ok" : b.resultado === "fail" ? "fail" : null;
  if (!resultado) return null;
  let motivo = MOTIVOS.has(b.motivo) ? b.motivo : "dato_invalido";
  if (resultado === "ok") motivo = "ok";
  return {
    resultado,
    motivo,
    sesion: txt(b.sesion, 24),
    numeroTren: num(b.numero, 0, 99999, 0),
    via: b.via === "ida" || b.via === "vuelta" ? b.via : null,
    destino: txt(b.destino, 40),
    salidaProg: /^\d{2}:\d{2}$/.test(b.dep || "") ? b.dep : null, // hora programada de salida desde la cabecera
    fuenteTren: FUENTES.has(b.fuenteTren) ? b.fuenteTren : null,
    posTren: num(b.posTren, 0, 20),                // posición del tren en el ramal (0 = Once ... 15 = Moreno)
    posUsuario: num(b.posUsuario, 0, 20),          // posición del celular proyectada sobre el ramal
    difEstaciones: num(b.difEstaciones, 0, 20),    // |posUsuario − posTren|
    toleranciaEstaciones: num(b.tolerancia, 0, 5),
    distEjeM: num(b.distEjeM, 0, 200000, 0),       // distancia del celular al eje de las vías
    precisionM: num(b.precisionM, 0, 200000, 0),   // precisión que informó el GPS del celular
    demoraMin: num(b.demoraMin, -60, 600, 0),
    pagina: b.pagina === "prueba" ? "prueba" : "produccion",
  };
}

export async function registrarValidacion(body) {
  const doc = normalizarValidacion(body);
  if (!doc) return { ok: false, error: "payload inválido" };
  const db = firestoreDb();
  if (!db) return { ok: false, error: "Firestore no configurado" };
  await db.collection(COLECCION).add({ ...doc, fecha: FieldValue.serverTimestamp() });
  return { ok: true };
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
const mediana = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n, d = 2) => (n === null || n === undefined ? "–" : n.toFixed(d).replace(".", ","));

const ETIQUETA_MOTIVO = {
  ok: "validó bien",
  sin_permiso: "no dio permiso de ubicación",
  gps_no_disponible: "GPS sin señal / no disponible",
  tiempo_agotado: "el GPS tardó demasiado",
  sin_geolocalizacion: "el navegador no tiene GPS",
  impreciso: "GPS demasiado impreciso",
  lejos_del_ramal: "estaba lejos de las vías",
  distinto_tramo: "GPS en otro tramo distinto al del tren",
  dato_invalido: "dato inválido",
};

// Resumen para el comando /validaciones de Telegram (admin). dias: ventana hacia atrás.
export async function textoValidaciones(dias = 7) {
  const db = firestoreDb();
  if (!db) return "Firestore no está configurado: no puedo leer las validaciones.";
  dias = Math.min(Math.max(Math.round(dias) || 7, 1), 90);
  const desde = new Date(Date.now() - dias * 86400000);
  const snap = await db.collection(COLECCION).where("fecha", ">=", desde).orderBy("fecha", "desc").limit(5000).get();
  const filas = snap.docs.map((d) => d.data());
  if (!filas.length) return `Sin validaciones registradas en los últimos ${dias} día(s).`;

  const oks = filas.filter((f) => f.resultado === "ok");
  const sesiones = new Set(filas.map((f) => f.sesion).filter(Boolean));
  const out = [`📡 Validaciones de usuario — últimos ${dias} día(s)${filas.length >= 5000 ? " (tope de 5000 intentos)" : ""}`];
  out.push(`Intentos: ${filas.length} · Validaron bien: ${oks.length} (${pct(oks.length, filas.length)}) · Sesiones distintas: ${sesiones.size || "–"}`);

  // Precisión real: solo cuando el celular estaba sobre el ramal y con GPS usable (se pudo comparar).
  const comparables = filas.filter((f) => typeof f.difEstaciones === "number");
  const difs = comparables.map((f) => f.difEstaciones);
  if (difs.length) {
    out.push(`\nDiferencia celular vs. formación (${difs.length} comparaciones): mediana ${fmt(mediana(difs))} estaciones · promedio ${fmt(difs.reduce((a, b) => a + b, 0) / difs.length)} · máx ${fmt(Math.max(...difs))}`);
  }

  out.push("\nPor fuente de posición del tren:");
  for (const fuente of ["gps", "estimada"]) {
    const g = filas.filter((f) => f.fuenteTren === fuente);
    if (!g.length) continue;
    const gOk = g.filter((f) => f.resultado === "ok").length;
    const gd = g.filter((f) => typeof f.difEstaciones === "number").map((f) => f.difEstaciones);
    out.push(`• ${fuente === "gps" ? "GPS real de la formación" : "Estimada por horarios"}: ${g.length} intentos, ${pct(gOk, g.length)} validó${gd.length ? `, dif. mediana ${fmt(mediana(gd))} est.` : ""}`);
  }

  out.push("\nMotivos:");
  const porMotivo = new Map();
  for (const f of filas) porMotivo.set(f.motivo, (porMotivo.get(f.motivo) || 0) + 1);
  for (const [m, n] of [...porMotivo.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`• ${ETIQUETA_MOTIVO[m] || m}: ${n} (${pct(n, filas.length)})`);
  }

  const precs = filas.map((f) => f.precisionM).filter((n) => typeof n === "number");
  if (precs.length) out.push(`\nPrecisión del GPS del celular: mediana ${Math.round(mediana(precs))} m`);

  const porSentido = ["ida", "vuelta"].map((v) => {
    const g = filas.filter((f) => f.via === v);
    return g.length ? `${v === "ida" ? "hacia Moreno" : "hacia Once"}: ${g.length} (${pct(g.filter((f) => f.resultado === "ok").length, g.length)} ok)` : null;
  }).filter(Boolean);
  if (porSentido.length) out.push(`Por sentido → ${porSentido.join(" · ")}`);

  out.push("\nLos intentos con motivo \"GPS en otro tramo\" suelen indicar que la posición del tren (en especial si es estimada) se desvió: son los que conviene revisar.");
  return out.join("\n");
}
