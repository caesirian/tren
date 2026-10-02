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
// Las salidas detectadas se guardan en Firestore (colección salidasFormaciones) y las
// llegadas a las cabeceras en llegadasFormaciones, para poder medir después puntualidad
// real (informe por formación: informeFormaciones.js, comando /formaciones informe). NO publica nada en el grupo: solo alimenta el contexto
// del bot (contextoSalidasParaBot) y el comando de admin /formaciones.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import {
  serviciosSarmiento,
  datosServicio,
  gpsValido,
  hora,
  indiceEstacionRamal,
  COORDS_ESTACIONES,
} from "./appTrenes.js";
import { buscarEnCronograma, esServicioDiferencial, localesActivos, localesConNumero, getDayType, minutoDelDia } from "./schedule.js";

const CABECERAS = [
  { nombre: "Once", idx: 0 },
  { nombre: "Moreno", idx: 15 },
];
const COLECCION = "salidasFormaciones";
const COLECCION_LLEGADAS = "llegadasFormaciones";
const INTERVALO_MS = Math.max(15000, Number(process.env.SALIDAS_INTERVALO_MS) || 30000);
const INTERVALO_SIN_TRENES_MS = 5 * 60 * 1000;
const RADIO_M = Number(process.env.SALIDAS_RADIO_ESTACION_M) || 350;
const MOVIMIENTO_MIN_M = 80; // variación de distancia entre dos muestras que cuenta como "se mueve"
const OLVIDAR_MS = 30 * 60 * 1000;
const AUSENCIAS_PARA_PERSISTIR = 2;
// Locales (nacen en Flores, Liniers, Merlo o Castelar): esas estaciones se consultan SOLO
// alrededor de la salida programada de un local, para no sumar pedidos al proxy todo el día.
const LOCAL_VENTANA_ANTES_MIN = 40;
const LOCAL_VENTANA_DESPUES_MIN = 40;
const DATO_VIEJO_MS = 3 * 60 * 1000; // más viejo que esto, un estado "en vivo" ya no vale

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

// Tipo de servicio para el informe: "diferencial" (por horario, no figura en el cronograma),
// "local" (la formación nació en una estación intermedia) o "comun". Ojo: rec.tipo es la
// dirección ("sale" | "llega") respecto de la cabecera, no el tipo de servicio.
function tipoServicioDe(rec) {
  try {
    const sale = rec.tipo === "sale";
    if (esServicioDiferencial({ cabecera: rec.cabecera, sale, prog: rec.prog, numero: rec.numero })) return "diferencial";
    const iOrigen = indiceEstacionRamal(rec.origen);
    if (iOrigen > 0 && iOrigen < 15) return "local";
    const haciaMoreno = sale ? rec.cabecera === "Once" : rec.cabecera === "Moreno";
    const cron = buscarEnCronograma({ numero: rec.numero, sentido: haciaMoreno ? "m" : "o", estacionNombre: rec.cabecera, prog: rec.prog });
    if (cron?.esLocal) return "local";
  } catch (err) {
    console.error("Error clasificando tipo de servicio:", err.message);
  }
  return "comun";
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
    else if (cab.intermedia) continue; // en una estación intermedia solo interesan los locales (nacen ahí); el resto pasa de largo
    else if (idxDestino === cab.idx) tipo = "llega";
    else if (idxOrigen < 0 && idxDestino >= 0) tipo = "sale"; // sin origen informado: se asume que sale de acá
    if (!tipo) continue; // pasa por la cabecera sin nacer ni terminar ahí (servicio limitado, etc.)

    const key = `${cab.nombre}|${numero}`;
    let rec = vivos.get(key);
    if (!rec) {
      rec = { key, numero, cabecera: cab.nombre, intermedia: !!cab.intermedia, tipo, primeraVista: ahora, estado: null, ausentes: 0, persistido: false, dist: null };
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
    if (rec.llegoEn && !rec.persistidoLlegada) persistirLlegada(rec);
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
        if (rec.estado === "en_camino") {
          rec.llegoEn = rec.llegoEn || rec.ultimaVista;
          rec.llegoFuente = rec.llegoFuente || "inferida";
        }
        rec.estado = "termino";
        rec.estadoDesde = ahora;
        if (rec.llegoEn && !rec.persistidoLlegada) persistirLlegada(rec);
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
          tipoServicio: tipoServicioDe(rec),
          fecha,
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

async function persistirLlegada(rec) {
  rec.persistidoLlegada = true; // se marca antes para no duplicar aunque falle Firestore
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    const fecha = new Date(rec.llegoEn - 3 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    await firestore
      .collection(COLECCION_LLEGADAS)
      .doc(`${fecha}_${rec.cabecera}_${rec.numero}`)
      .set(
        {
          numero: rec.numero,
          cabecera: rec.cabecera,
          origen: rec.origen || null,
          programada: rec.prog || null,
          estimada: rec.estim || null,
          demoraMin: rec.demora ?? null,
          tipoServicio: tipoServicioDe(rec),
          fecha,
          llegoEn: new Date(rec.llegoEn).toISOString(),
          fuente: rec.llegoFuente || "detectada",
          precisionSeg: rec.llegoFuente === "real" ? 0 : Math.round(INTERVALO_MS / 1000),
          registradoEn: new Date().toISOString(),
        },
        { merge: true }
      );
  } catch (err) {
    console.error("Error guardando llegada de formación:", err.message);
  }
}

// Registros de un día (fecha "YYYYMMDD", hora de Buenos Aires) para el informe de formaciones.
// Los ids de documento empiezan con la fecha, así que alcanza un rango por id (sin índices).
export async function leerRegistrosDia(fecha) {
  const firestore = ensureInit();
  if (!firestore) throw new Error("Firestore no está configurado en el bot");
  const leer = async (col) => {
    const snap = await firestore
      .collection(col)
      .where(FieldPath.documentId(), ">=", `${fecha}_`)
      .where(FieldPath.documentId(), "<", `${fecha}_\uf8ff`)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  };
  const [salidas, llegadas] = await Promise.all([leer(COLECCION), leer(COLECCION_LLEGADAS)]);
  return { salidas, llegadas };
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
  let hayLocalActivo = false;
  try {
    // Cabeceras siempre; estaciones intermedias solo si un local sale de ahí en la ventana.
    const extra = [];
    for (const l of localesActivos(new Date(ahora), LOCAL_VENTANA_ANTES_MIN, LOCAL_VENTANA_DESPUES_MIN)) {
      if (!extra.some((e) => e.nombre === l.estacion)) extra.push({ nombre: l.estacion, idx: l.estacionId, intermedia: true });
    }
    hayLocalActivo = extra.length > 0;
    const consultas = [...CABECERAS, ...extra];
    const res = await Promise.allSettled(consultas.map((c) => serviciosSarmiento(c.nombre)));
    res.forEach((r, i) => {
      const cab = consultas[i];
      if (r.status === "rejected") {
        erroresPorCabecera[cab.nombre] = `${r.reason?.message || r.reason}`.slice(0, 160);
        return; // no se evalúan ausencias si la consulta falló
      }
      delete erroresPorCabecera[cab.nombre];
      if (r.value.servicios.length && !cab.intermedia) huboTrenes = true;
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
  return huboTrenes || hayLocalActivo;
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
      return `todavía no llegó a ${r.intermedia ? "la estación" : "la cabecera"} (a ${km(r.dist)})`;
    case "posicion_lejos":
      return `ubicado a ${km(r.dist)} de ${r.intermedia ? "la estación" : "la cabecera"}`;
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
  const locales = [...vivos.values()].filter((r) => r.intermedia && r.estado).sort((a, b) => new Date(a.prog || 0) - new Date(b.prog || 0));
  if (locales.length) t += `\n— Locales (se vigilan ±${LOCAL_VENTANA_ANTES_MIN} min de su salida) —\n${locales.map(lineaFormacion).join("\n")}\n`;
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

// ─────────────────────────────────────────────────────────────────────────
// Locales: "¿ya salió el local de las 7:10 de Merlo?"
// ─────────────────────────────────────────────────────────────────────────
const normTxt = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const aHM = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Horarios que aparecen en el texto ("las 7:10", "19h30", "el de las 7") como minutos del día.
// Sin AM/PM no se sabe cuál es: de 1 a 11 se prueban la mañana y la tarde.
export function horasMencionadas(texto) {
  const t = String(texto || "");
  const out = new Set();
  const agregar = (h, m) => {
    if (h > 23) return;
    out.add(h * 60 + m);
    if (h >= 1 && h <= 11) out.add((h + 12) * 60 + m);
  };
  for (const x of t.matchAll(/\b([01]?\d|2[0-3])\s*[:.h]\s*([0-5]\d)\b/gi)) agregar(+x[1], +x[2]);
  for (const x of t.matchAll(/\blas?\s+([01]?\d|2[0-3])\b(?!\s*[:.h]\s*\d)/gi)) agregar(+x[1], 0);
  for (const x of t.matchAll(/\b([01]?\d|2[0-3])\s*(?:hs|horas)\b/gi)) agregar(+x[1], 0);
  return [...out];
}

let cacheHoy = { fecha: null, momento: 0, salidas: [] };
async function salidasGuardadasHoy() {
  const fecha = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  if (cacheHoy.fecha === fecha && Date.now() - cacheHoy.momento < 60 * 1000) return cacheHoy.salidas;
  try {
    const { salidas } = await leerRegistrosDia(fecha);
    cacheHoy = { fecha, momento: Date.now(), salidas };
  } catch (err) {
    console.error("No pude leer las salidas guardadas de hoy:", err.message);
    cacheHoy = { fecha, momento: Date.now(), salidas: [] };
  }
  return cacheHoy.salidas;
}

// Una formación (en vivo o guardada) corresponde al local del cronograma si tiene el mismo
// número o, si el proxy usa otra numeración, si el horario programado difiere hasta 3 min.
const esElLocal = (numero, progIso, local) =>
  String(numero) === String(local.n) || (progIso && Math.abs(minutoDelDia(progIso) - local.min) <= 3);

function fraseLocal(r) {
  const t = (ms) => hora(new Date(ms).toISOString());
  const hace = Math.round((Date.now() - (r.ultimaVista || 0)) / 60000);
  const viejo = Date.now() - (r.ultimaVista || 0) > DATO_VIEJO_MS;
  const horario = `prog ${hora(r.prog)}${r.estim && r.estim !== r.prog ? ` / est ${hora(r.estim)}` : ""}`;
  switch (r.estado) {
    case "cancelado":
      return `${horario} · figura CANCELADO`;
    case "salio":
    case "en_marcha":
    case "salio_inferido":
      return `${horario} · YA SALIÓ${r.salioEn ? ` a las ${t(r.salioEn)}${r.salioFuente === "real" ? "" : " (aprox.)"}` : ""}`;
    case "en_estacion":
      if (viejo) return `${horario} · estaba en el andén esperando${r.enEstacionDesde ? ` desde las ${t(r.enEstacionDesde)}` : ""}, pero hace ${hace} min que no hay datos nuevos: no se puede confirmar si ya salió`;
      return `${horario} · ESTÁ EN EL ANDÉN ESPERANDO PARA SALIR${r.enEstacionDesde ? ` (desde las ${t(r.enEstacionDesde)})` : ""}${r.anden ? ` · andén ${r.anden}` : ""}`;
    case "aproximando":
      return viejo ? `${horario} · aún no había llegado a la estación (hace ${hace} min sin datos nuevos)` : `${horario} · TODAVÍA NO LLEGÓ a la estación (viene acercándose, a ${km(r.dist)})`;
    case "posicion_lejos":
      return `${horario} · ubicado a ${km(r.dist)} de la estación: no se puede confirmar si ya salió o si todavía viene`;
    case "sin_posicion":
      return `${horario} · figura programado pero todavía sin posición: no hay confirmación de que ya esté en la estación`;
    default:
      return `${horario} · sin dato`;
  }
}

function fraseLocalGuardado(d) {
  const t = (iso) => hora(iso);
  const aprox = d.fuente === "real" ? "" : " (aprox.)";
  return `prog ${hora(d.programada)} · YA SALIÓ a las ${t(d.salioEn)}${aprox}${d.enEstacionDesde ? `; estuvo en el andén desde las ${t(d.enEstacionDesde)}` : ""}`;
}

// Bloque para el contexto de Gemini con el estado de los locales de HOY: ya salió / está en el
// andén esperando / todavía no llegó. `estacion`: nombre de la estación (null = todas).
// Se incluyen los locales de las últimas 2 h y próximas 1,5 h y los de un horario que se
// nombre en la pregunta. Devuelve null si no hay nada que informar.
export async function estadoLocalesParaBot({ estacion = null, pregunta = "", ahora = new Date() } = {}) {
  if (!vigiaSalidasActiva()) return null;
  const dia = getDayType(ahora);
  const ahoraMin = minutoDelDia(ahora);
  const pedidas = horasMencionadas(pregunta);

  const locales = localesConNumero(dia)
    .map((l) => ({ ...l, min: Number(l.hora.slice(0, 2)) * 60 + Number(l.hora.slice(3, 5)) }))
    .filter((l) => !estacion || normTxt(l.estacion) === normTxt(estacion))
    .filter((l) => (l.min >= ahoraMin - 120 && l.min <= ahoraMin + 90) || pedidas.some((p) => Math.abs(p - l.min) <= 10))
    .sort((a, b) => a.min - b.min);
  if (!locales.length) return null;

  const vivoOk = !!ultimoTick && Date.now() - ultimoTick <= 5 * 60 * 1000;
  let guardadas = null;
  const lineas = [];
  for (const l of locales) {
    const cab = `Local de las ${l.hora} de ${l.estacion} hacia ${l.direccion === "moreno" ? "Moreno" : "Once"} (#${l.n})`;
    const rec = [...vivos.values()].find((r) => r.intermedia && r.tipo === "sale" && normTxt(r.cabecera) === normTxt(l.estacion) && r.estado && esElLocal(r.numero, r.prog, l));
    if (rec) {
      lineas.push(`- ${cab}: ${fraseLocal(rec)}`);
      continue;
    }
    if (l.min < ahoraMin - 5) {
      guardadas ||= await salidasGuardadasHoy();
      const d = guardadas.find((x) => normTxt(x.cabecera) === normTxt(l.estacion) && esElLocal(x.numero, x.programada, l));
      if (d) {
        lineas.push(`- ${cab}: ${fraseLocalGuardado(d)}`);
        continue;
      }
    }
    const falta = l.min - ahoraMin;
    if (!vivoOk) lineas.push(`- ${cab}: sin datos en vivo en este momento; según el horario sale a las ${l.hora}.`);
    else if (falta > LOCAL_VENTANA_ANTES_MIN) lineas.push(`- ${cab}: todavía falta (sale a las ${l.hora}, en ${falta} min); recién se lo ve en la app poco antes de la salida.`);
    else if (falta >= -LOCAL_VENTANA_DESPUES_MIN) lineas.push(`- ${cab}: todavía NO figura en la app (ni en el andén ni con posición): no hay confirmación de que ya esté en la estación. Según el horario sale a las ${l.hora}.`);
    else lineas.push(`- ${cab}: no hay registro de su salida; según el horario ya debería haber salido a las ${l.hora}, pero no hay confirmación.`);
  }

  return (
    `\n== ESTADO EN VIVO DE LOS LOCALES DE HOY${estacion ? ` EN ${estacion.toUpperCase()}` : ""} (declarado fuente de verdad; hora actual en Buenos Aires: ${aHM(ahoraMin)}) ==\n` +
    lineas.join("\n") +
    `\nUsalo para contestar si un local ya salió (y a qué hora), si está esperando en el andén o si todavía no llegó a la estación. Si preguntan por un local puntual (por su horario), contestá SOLO por ese; si preguntan por los locales en general, usá esta lista junto con el cronograma. "aprox." = margen de menos de un minuto. ` +
    `Si no hay confirmación, decilo tal cual: según el horario sale a tal hora pero no hay confirmación de que ya esté. No inventes ni deduzcas un estado que acá no figura. ` +
    `Nunca menciones cómo se obtiene este dato ni hables de GPS, sistemas o mecanismos internos.`
  );
}

export function estadoVigia() {
  return { activa: vigiaSalidasActiva(), intervaloMs: INTERVALO_MS, radioM: RADIO_M, ultimoTick, formaciones: vivos.size, errores: { ...erroresPorCabecera } };
}
