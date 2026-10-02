// src/vigiaSalidas.js
// Vigilancia de formaciones en las CABECERAS (Once y Moreno): sabe si una formación
// todavía no tiene posición, está EN ESTACIÓN esperando, ya SALIÓ (y a qué hora) o está
// llegando. Pedido de Coco (2/10): "que el bot sepa en qué momento efectivamente sale
// una formación de estación, si ya llegó y está esperando o si está en camino".
//
// Fuente: el mismo proxy de la app de Trenes Argentinos que ya usa el resto del bot.
// Cada servicio trae servicio.location {lat, long} (GPS real de la formación) y, a veces,
// arribo.salida.real / arribo.llegada.real. Se combinan tres señales:
//   1) distancia del GPS a la cabecera (<= RADIO = en estación; más lejos y alejándose = salió),
//   2) hora real informada por la app (si viene, manda),
//   3) la formación deja de figurar en la lista de la cabecera (salida inferida; se confirma
//      recién a la 2ª ausencia seguida para no tomar como salida un fallo puntual del proxy).
//
// Consulta SOLO Once y Moreno (2 pedidos por vuelta): como todo tren que circula tiene
// una de las dos cabeceras por delante, con eso se ve toda la flota. Intervalo 30 s por
// defecto (el proxy no cachea: pasa directo a SOFSE). Sin trenes (madrugada) baja a 5 min.
//
// Config (todo opcional):
//   SALIDAS_VIGIA_ACTIVO=false        apaga la vigilancia
//   SALIDAS_INTERVALO_MS=30000        intervalo entre consultas (mínimo 15000)
//   SALIDAS_RADIO_ESTACION_M=350      radio alrededor de la cabecera que cuenta como "en estación"
//
// Las salidas detectadas se guardan en Firestore (colección salidasFormaciones) para poder
// medir después puntualidad real. NO publica nada en el grupo: solo alimenta el contexto
// del bot (contextoSalidasParaBot) y el comando de admin /formaciones.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  serviciosSarmiento,
  datosServicio,
  gpsValido,
  hora,
  indiceEstacionRamal,
  COORDS_ESTACIONES,
} from "./appTrenes.js";

const CABECERAS = [
  { nombre: "Once", idx: 0 },
  { nombre: "Moreno", idx: 15 },
];
const COLECCION = "salidasFormaciones";
const INTERVALO_MS = Math.max(15000, Number(process.env.SALIDAS_INTERVALO_MS) || 30000);
const INTERVALO_SIN_TRENES_MS = 5 * 60 * 1000;
const RADIO_M = Number(process.env.SALIDAS_RADIO_ESTACION_M) || 350;
const MOVIMIENTO_MIN_M = 80; // variación de distancia entre dos muestras que cuenta como "se mueve"
const OLVIDAR_MS = 30 * 60 * 1000;
const AUSENCIAS_PARA_PERSISTIR = 2;

export function vigiaSalidasActiva() {
  return String(process.env.SALIDAS_VIGIA_ACTIVO ?? "true").trim().toLowerCase() !== "false";
}

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
    console.error("Error inicializando Firebase en vigiaSalidas:", err.message);
    return null;
  }
}

function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Registro vivo por formación y cabecera: `${cabecera}|${numero}`.
const vivos = new Map();
let timer = null;
let enCurso = false;
let ultimoTick = 0;
let ultimoTickConTrenes = 0;
const erroresPorCabecera = {};

const aMs = (iso) => (iso ? new Date(iso).getTime() : null);

function clasificar(rec, tipo, dist, realSalida, realLlegada, distPrev) {
  if (rec.cancelado) return "cancelado";
  const cerca = dist != null && dist <= RADIO_M;
  if (tipo === "sale") {
    if (realSalida) return "salio";
    if (cerca) return "en_estacion";
    if (dist == null) return "sin_posicion";
    // GPS lejos de la cabecera: ¿ya salió o todavía viene hacia ella?
    // Histéresis: estando en estación, para darlo por salido tiene que alejarse bien del radio
    // (evita falsos positivos por rebote del GPS dentro de una cabecera larga).
    if (rec.estado === "en_marcha") return "en_marcha";
    if (rec.estado === "en_estacion") return dist > RADIO_M * 1.5 ? "en_marcha" : "en_estacion";
    if (distPrev != null) {
      const delta = dist - distPrev;
      if (delta > MOVIMIENTO_MIN_M) return "en_marcha";
      if (delta < -MOVIMIENTO_MIN_M) return "aproximando";
      if (rec.estado === "aproximando" || rec.estado === "posicion_lejos") return rec.estado;
    }
    return "posicion_lejos"; // primera vez que se lo ve y está lejos: no se puede afirmar que salió
  }
  // tipo "llega": formación que termina su recorrido en esta cabecera
  if (realLlegada || cerca) return "llego";
  if (dist == null) return "sin_posicion";
  return "en_camino";
}

function procesarCabecera(cab, servicios, ahora) {
  const vistos = new Set();
  const [latCab, longCab] = COORDS_ESTACIONES[cab.idx];

  for (const item of servicios) {
    const d = datosServicio(item);
    const numero = d.s.numero;
    if (numero == null) continue;

    const idxOrigen = indiceEstacionRamal(d.origenReal);
    const idxDestino = indiceEstacionRamal(d.destino);
    let tipo = null;
    if (idxOrigen === cab.idx) tipo = "sale";
    else if (idxDestino === cab.idx) tipo = "llega";
    else if (idxOrigen < 0 && idxDestino >= 0) tipo = "sale"; // sin origen informado: se asume que sale de acá
    if (!tipo) continue; // pasa por la cabecera sin nacer ni terminar ahí (servicio limitado, etc.)

    const key = `${cab.nombre}|${numero}`;
    let rec = vivos.get(key);
    if (!rec) {
      rec = { key, numero, cabecera: cab.nombre, tipo, primeraVista: ahora, estado: null, ausentes: 0, persistido: false, dist: null };
      vivos.set(key, rec);
    }
    vistos.add(key);

    const gps = gpsValido(d.s.location);
    const dist = gps ? Math.round(distM(gps.lat, gps.long, latCab, longCab)) : null;
    const realSalida = item.r?.arribo?.salida?.real || null;
    const realLlegada = item.r?.arribo?.llegada?.real || null;
    const distPrev = rec.dist;

    rec.tipo = tipo;
    rec.destino = d.destino;
    rec.origen = d.origenReal;
    rec.prog = d.prog;
    rec.estim = d.estim;
    rec.demora = d.demora;
    rec.anden = d.anden;
    rec.cancelado = !!d.s.cancelacion;
    rec.dist = dist;
    rec.ultimaVista = ahora;
    rec.ausentes = 0;

    const previo = rec.estado;
    const nuevo = clasificar(rec, tipo, dist, realSalida, realLlegada, distPrev);

    // La formación reapareció después de haber sido dada por salida inferida: era un fallo del proxy.
    if (previo === "salio_inferido" && nuevo === "en_estacion") {
      rec.salioEn = null;
      rec.salioFuente = null;
    }

    if (nuevo !== previo) {
      if (nuevo === "en_estacion" && !rec.enEstacionDesde) rec.enEstacionDesde = ahora;
      if (tipo === "sale" && (nuevo === "en_marcha" || nuevo === "salio") && !rec.salioEn) {
        const real = aMs(realSalida);
        rec.salioEn = real ?? ahora;
        rec.salioFuente = real ? "real" : "detectada";
        rec.salioPrevio = previo;
      }
      if (tipo === "llega" && nuevo === "llego" && !rec.llegoEn) {
        const real = aMs(realLlegada);
        rec.llegoEn = real ?? ahora;
        rec.llegoFuente = real ? "real" : "detectada";
      }
      rec.estado = nuevo;
      rec.estadoDesde = ahora;
    }
    if (rec.salioEn && !rec.persistido && rec.estado !== "salio_inferido") persistirSalida(rec);
  }

  // Formaciones que figuraban antes en esta cabecera y ya no: salida inferida / fin de recorrido.
  for (const rec of vivos.values()) {
    if (rec.cabecera !== cab.nombre || vistos.has(rec.key)) continue;
    rec.ausentes += 1;
    if (rec.tipo === "sale" && (rec.estado === "en_estacion" || rec.estado === "salio_inferido")) {
      if (rec.estado !== "salio_inferido") {
        rec.estado = "salio_inferido";
        rec.estadoDesde = ahora;
        rec.salioEn = rec.ultimaVista + Math.round((ahora - rec.ultimaVista) / 2); // punto medio entre la última muestra y esta
        rec.salioFuente = "inferida";
        rec.salioPrevio = "en_estacion";
      }
      if (rec.ausentes >= AUSENCIAS_PARA_PERSISTIR && !rec.persistido) persistirSalida(rec);
    } else if (rec.tipo === "llega" && (rec.estado === "llego" || rec.estado === "en_camino")) {
      if (rec.estado !== "termino") {
        if (rec.estado === "en_camino") rec.llegoEn = rec.llegoEn || rec.ultimaVista;
        rec.estado = "termino";
        rec.estadoDesde = ahora;
      }
    }
  }
}

async function persistirSalida(rec) {
  rec.persistido = true; // se marca antes para no duplicar aunque falle Firestore
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    const fecha = new Date(rec.salioEn - 3 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    await firestore
      .collection(COLECCION)
      .doc(`${fecha}_${rec.cabecera}_${rec.numero}`)
      .set(
        {
          numero: rec.numero,
          cabecera: rec.cabecera,
          destino: rec.destino || null,
          programada: rec.prog || null,
          estimada: rec.estim || null,
          demoraMin: rec.demora ?? null,
          anden: rec.anden || null,
          enEstacionDesde: rec.enEstacionDesde ? new Date(rec.enEstacionDesde).toISOString() : null,
          salioEn: new Date(rec.salioEn).toISOString(),
          fuente: rec.salioFuente,
          precisionSeg: rec.salioFuente === "real" ? 0 : Math.round(INTERVALO_MS / 1000),
          registradoEn: new Date().toISOString(),
        },
        { merge: true }
      );
  } catch (err) {
    console.error("Error guardando salida de formación:", err.message);
  }
}

function limpiar(ahora) {
  for (const [k, rec] of vivos) {
    const ref = rec.ultimaVista || rec.primeraVista;
    if (ahora - ref > OLVIDAR_MS) vivos.delete(k);
  }
}

async function vuelta() {
  if (enCurso) return false;
  enCurso = true;
  const ahora = Date.now();
  let huboTrenes = false;
  try {
    const res = await Promise.allSettled(CABECERAS.map((c) => serviciosSarmiento(c.nombre)));
    res.forEach((r, i) => {
      const cab = CABECERAS[i];
      if (r.status === "rejected") {
        erroresPorCabecera[cab.nombre] = `${r.reason?.message || r.reason}`.slice(0, 160);
        return; // no se evalúan ausencias si la consulta falló
      }
      delete erroresPorCabecera[cab.nombre];
      if (r.value.servicios.length) huboTrenes = true;
      procesarCabecera(cab, r.value.servicios, ahora);
    });
    limpiar(ahora);
    ultimoTick = ahora;
    if (huboTrenes) ultimoTickConTrenes = ahora;
  } catch (err) {
    console.error("Error en la vigilancia de salidas:", err.message);
  } finally {
    enCurso = false;
  }
  return huboTrenes;
}

// Fuerza una vuelta de consulta ahora (para pruebas o para refrescar a pedido).
export async function vigilarAhora() {
  return vuelta();
}

export function iniciarVigiaSalidas() {
  if (!vigiaSalidasActiva()) {
    console.log("Vigilancia de salidas: APAGADA (SALIDAS_VIGIA_ACTIVO=false)");
    return;
  }
  if (timer) return;
  console.log(`Vigilancia de salidas: ACTIVA (cada ${Math.round(INTERVALO_MS / 1000)} s, radio ${RADIO_M} m)`);
  const programar = (ms) => {
    timer = setTimeout(async () => {
      const huboTrenes = await vuelta();
      programar(huboTrenes ? INTERVALO_MS : INTERVALO_SIN_TRENES_MS);
    }, ms);
    timer.unref?.();
  };
  programar(5000);
}

// ─────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

function fraseEstado(r) {
  const t = (ms) => hora(new Date(ms).toISOString());
  switch (r.estado) {
    case "cancelado":
      return "CANCELADO";
    case "en_estacion":
      return `en estación, esperando para salir${r.enEstacionDesde ? ` (desde ${t(r.enEstacionDesde)})` : ""}`;
    case "en_marcha":
    case "salio":
      return r.salioEn ? `ya salió a las ${t(r.salioEn)}${r.salioFuente === "real" ? "" : " (aprox.)"}` : "ya salió (en marcha)";
    case "salio_inferido":
      return `ya salió (aprox. ${t(r.salioEn)})`;
    case "aproximando":
      return `todavía no llegó a la cabecera (a ${km(r.dist)})`;
    case "posicion_lejos":
      return `ubicado a ${km(r.dist)} de la cabecera`;
    case "sin_posicion":
      return "todavía sin posición (figura programado)";
    case "en_camino":
      return `en camino, a ${km(r.dist)}`;
    case "llego":
      return `ya llegó${r.llegoEn ? ` a las ${t(r.llegoEn)}` : ""}`;
    case "termino":
      return "terminó su recorrido";
    default:
      return "sin dato";
  }
}

export function formacionesEnCabeceras() {
  const ordenHora = (a, b) => new Date(a.estim || a.prog || 0) - new Date(b.estim || b.prog || 0);
  const out = {};
  for (const cab of CABECERAS) {
    out[cab.nombre] = [...vivos.values()].filter((r) => r.cabecera === cab.nombre && r.estado).sort(ordenHora);
  }
  return out;
}

function lineaFormacion(r) {
  const horario = `prog ${hora(r.prog)}${r.estim && r.estim !== r.prog ? ` / est ${hora(r.estim)}` : ""}`;
  const dir = r.tipo === "sale" ? `${r.cabecera} → ${r.destino}` : `${r.origen || "?"} → ${r.cabecera}`;
  return `#${r.numero} ${dir} · ${horario}${r.anden && r.tipo === "sale" ? ` · andén ${r.anden}` : ""} · ${fraseEstado(r)}`;
}

// Texto para el admin (/formaciones).
export function textoFormaciones() {
  if (!vigiaSalidasActiva()) return "La vigilancia de salidas está apagada (SALIDAS_VIGIA_ACTIVO=false).";
  const por = formacionesEnCabeceras();
  const edad = ultimoTick ? Math.round((Date.now() - ultimoTick) / 1000) : null;
  let t = `🚉 Formaciones en cabeceras — vigilancia cada ${Math.round(INTERVALO_MS / 1000)} s${edad != null ? ` · última vuelta hace ${edad} s` : " · todavía sin vueltas"}\n`;
  for (const cab of CABECERAS) {
    const lista = por[cab.nombre];
    t += `\n— ${cab.nombre} —\n`;
    if (erroresPorCabecera[cab.nombre]) t += `⚠️ Última consulta falló: ${erroresPorCabecera[cab.nombre]}\n`;
    if (!lista.length) {
      t += "(sin formaciones registradas)\n";
      continue;
    }
    for (const r of lista.slice(0, 14)) t += `${lineaFormacion(r)}\n`;
  }
  if (!ultimoTickConTrenes && ultimoTick) t += "\nNo se vieron trenes de Sarmiento en las últimas consultas.";
  return t.trim();
}

// Bloque para el contexto de Gemini: qué pasa AHORA en Once y Moreno. null si no hay nada útil.
export function contextoSalidasParaBot() {
  if (!vigiaSalidasActiva() || !ultimoTick || Date.now() - ultimoTick > 5 * 60 * 1000) return null;
  const por = formacionesEnCabeceras();
  const bloques = [];
  for (const cab of CABECERAS) {
    const relevantes = por[cab.nombre].filter((r) => r.tipo === "sale" && ["en_estacion", "en_marcha", "salio", "salio_inferido", "sin_posicion", "cancelado"].includes(r.estado));
    // Las salidas viejas ya no importan: se muestran solo las de los últimos 20 min.
    const vigentes = relevantes.filter((r) => !r.salioEn || Date.now() - r.salioEn < 20 * 60 * 1000);
    if (vigentes.length) bloques.push(`Cabecera ${cab.nombre}:\n` + vigentes.slice(0, 8).map((r) => `- ${lineaFormacion(r)}`).join("\n"));
  }
  if (!bloques.length) return null;
  return (
    `\n== FORMACIONES EN LAS CABECERAS AHORA (en vivo, declarado fuente de verdad) ==\n` +
    bloques.join("\n") +
    `\nUsalo para contestar si un tren ya salió, si está esperando en la estación o a qué hora salió. "aprox." significa que la hora tiene un margen de menos de un minuto. ` +
    `Si un tren figura "todavía sin posición", decí que según el horario sale a tal hora pero que no hay confirmación de que ya esté en la estación. ` +
    `Nunca menciones cómo se obtiene este dato ni hables de GPS, sistemas o mecanismos internos.`
  );
}

export function estadoVigia() {
  return { activa: vigiaSalidasActiva(), intervaloMs: INTERVALO_MS, radioM: RADIO_M, ultimoTick, formaciones: vivos.size, errores: { ...erroresPorCabecera } };
}
