// src/trenDetenido.js
// Detecta trenes DETENIDOS usando el GPS que trae el proxy (servicio.location).
//
// Por qué existe: en un accidente o una detención, SOFSE puede dejar de actualizar la hora
// estimada del tren parado, y entonces la demora sigue figurando en 0 y ningún chequeo por
// demora se dispara. La posición, en cambio, deja de moverse. Este módulo compara la
// posición de cada tren entre barridos consecutivos (cada ~2,5 min) y avisa cuando lleva
// varios minutos sin moverse en un lugar donde no debería estar parado.
//
// Es lógica pura (sin red ni Firestore): recibe los servicios del barrido y un estado en
// memoria. Si el bot se reinicia, el estado se pierde y la cuenta vuelve a empezar (no genera
// falsos avisos, solo demora el aviso).
//
// Ajustes por variable de entorno:
//   TREN_DETENIDO_MIN_ENTRE      minutos parado ENTRE estaciones antes de avisar (5)
//   TREN_DETENIDO_MIN_ESTACION   minutos parado EN una estación intermedia (8)
//   TREN_DETENIDO_AUTO=false     apaga la detección

import { gpsValido, proyectarEnRamal, COORDS_ESTACIONES, ESTACIONES_BARRIDO, indiceEstacionRamal, datosServicio } from "./appTrenes.js";

const MOVIMIENTO_M = 150; // si se mueve más que esto desde el ancla, no está detenido
const EN_ESTACION_M = 400; // a menos de esto de una estación se considera "en la estación"
const CABECERA_M = 700; // zona de cabecera (Once / Moreno): ahí es normal esperar
const TERMINAL_M = 500; // zona de la estación donde empieza/termina ese servicio
const MAX_DIST_EJE_M = 1500; // GPS más lejos que esto del ramal = dato dudoso
const OLVIDAR_TRAS_MS = 30 * 60 * 1000;
const CLUSTER_ESTACIONES = 2; // 2+ trenes detenidos a menos de 2 "estaciones" entre sí = posible incidente

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};
export const detectorDetenidosActivo = () => String(process.env.TREN_DETENIDO_AUTO ?? "true").trim().toLowerCase() !== "false";
const minEntre = () => num(process.env.TREN_DETENIDO_MIN_ENTRE, 5);
const minEstacion = () => num(process.env.TREN_DETENIDO_MIN_ESTACION, 8);

function distanciaM(lat1, long1, lat2, long2) {
  const kx = 111320 * Math.cos((-34.64 * Math.PI) / 180);
  return Math.hypot((long2 - long1) * kx, (lat2 - lat1) * 110540);
}

function estacionMasCercana(lat, long) {
  let mejor = null;
  COORDS_ESTACIONES.forEach(([la, lo], idx) => {
    const d = distanciaM(lat, long, la, lo);
    if (!mejor || d < mejor.distM) mejor = { idx, distM: d };
  });
  return mejor;
}

// estado: Map numero -> { lat, long, desdeMs, vistoMs, avisado }
export function crearEstadoDetenidos() {
  return new Map();
}

// items: servicios del barrido [{ est, r }]. ahoraMs: momento del barrido.
// Devuelve la lista de trenes que ACABAN de cumplir el tiempo parado (una vez por episodio).
export function detectarDetenidos(items, estado, ahoraMs = Date.now()) {
  const nuevos = [];
  const vistosEnEsteBarrido = new Set();

  for (const item of items) {
    const d = datosServicio(item);
    if (d.s.cancelacion) continue;
    const numero = d.s.numero;
    if (numero == null || vistosEnEsteBarrido.has(numero)) continue;
    const gps = gpsValido(d.s.location);
    if (!gps) continue;
    const proy = proyectarEnRamal(gps.lat, gps.long);
    if (!proy || proy.distM > MAX_DIST_EJE_M) continue;
    vistosEnEsteBarrido.add(numero);

    const prev = estado.get(numero);
    if (!prev || distanciaM(prev.lat, prev.long, gps.lat, gps.long) > MOVIMIENTO_M) {
      // Primera vez que se lo ve, o se movió: la cuenta de "parado" vuelve a cero.
      estado.set(numero, { lat: gps.lat, long: gps.long, posicion: proy.posicion, desdeMs: ahoraMs, vistoMs: ahoraMs, avisado: false });
      continue;
    }
    prev.vistoMs = ahoraMs;
    prev.posicion = proy.posicion;

    const cerca = estacionMasCercana(gps.lat, gps.long);
    const enEstacion = cerca.distM <= EN_ESTACION_M;

    // Donde es normal estar parado: cabeceras y estaciones donde empieza/termina ese servicio.
    if (cerca.distM <= CABECERA_M && (cerca.idx === 0 || cerca.idx === ESTACIONES_BARRIDO.length - 1)) continue;
    const idxDestino = indiceEstacionRamal(d.destino);
    const idxOrigen = indiceEstacionRamal(d.origenReal);
    if (cerca.distM <= TERMINAL_M && (cerca.idx === idxDestino || cerca.idx === idxOrigen)) continue;

    const minutos = (ahoraMs - prev.desdeMs) / 60000;
    const umbral = enEstacion ? minEstacion() : minEntre();
    if (minutos < umbral || prev.avisado) continue;
    prev.avisado = true;

    const a = Math.floor(proy.posicion);
    const b = Math.min(ESTACIONES_BARRIDO.length - 1, a + 1);
    nuevos.push({
      numero,
      destino: d.destino,
      minutos: Math.round(minutos),
      posicion: proy.posicion,
      lugar: enEstacion ? `en ${ESTACIONES_BARRIDO[cerca.idx]}` : `entre ${ESTACIONES_BARRIDO[a]} y ${ESTACIONES_BARRIDO[b]}`,
      enEstacion,
      gps,
      prog: d.prog,
      estim: d.estim,
    });
  }

  // Limpieza: se olvidan los trenes que dejaron de aparecer (terminaron o salieron del barrido).
  for (const [numero, v] of estado) {
    if (ahoraMs - v.vistoMs > OLVIDAR_TRAS_MS) estado.delete(numero);
  }

  // Si varios trenes quedaron parados cerca unos de otros, probablemente es un incidente en la vía.
  // Se cuentan TODOS los que siguen detenidos ahora (no solo los recién detectados).
  const detenidosAhora = [...estado.entries()].filter(([, v]) => v.avisado && v.vistoMs === ahoraMs);
  nuevos.forEach((n) => {
    n.cercanos = detenidosAhora.filter(([k, v]) => k !== n.numero && Math.abs(v.posicion - n.posicion) <= CLUSTER_ESTACIONES).map(([k]) => k);
  });
  return nuevos;
}
