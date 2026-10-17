// src/marcha.js
// Velocidad y "marcha" de cada formación a partir del GPS real del proxy.
// El proxy solo trae servicio.location = { lat, long } (sin velocidad ni hora propia de la muestra),
// así que se guardan en memoria las últimas posiciones de cada tren y se comparan en el tiempo.
//
// MODO REGISTRO (oct 2026): se calculan y se agregan campos ADITIVOS a /api/tablero-mapa
// (velKmh, marcha, gpsSinCambioS) y se loguean estadísticas cada 5 min para validar el dato
// (sobre todo: cada cuánto cambia la coordenada del proxy) antes de pintar nada en el mapa.
//
// marcha: "normal" | "lento" | "detenido_via" (parado a más de RADIO_ESTACION_M de una estación)
//         | "en_estacion" | null (sin GPS, cancelado o sin muestras suficientes).
// Sin GPS real (posición estimada por horarios) NO se puede saber si está parado: marcha = null.

const MIN_ENTRE_MUESTRAS_MS = 20_000; // varios clientes consultan el endpoint: se toma una muestra cada ≥20 s
const VENTANA_MS = 80_000;            // se compara contra la muestra más vieja dentro de esta ventana
const MIN_SPAN_MS = 45_000;           // mínimo de tiempo cubierto para calcular velocidad
const MAX_MUESTRAS = 12;
const OLVIDAR_MS = 10 * 60_000;
const MOVIMIENTO_MIN_M = 3;           // menos que esto entre muestras = la coordenada "no cambió"
const UMBRAL_DETENIDO_KMH = 3;
const UMBRAL_LENTO_KMH = 15;
const RADIO_ESTACION_M = 300;
const RADIO_APROX_M = 600;            // cerca de una estación (frenada/arranque) no se marca "lento"
const CONFIRMAR = 2;                  // evaluaciones seguidas iguales para cambiar de estado (evita parpadeo)
const LOG_CADA_MS = 5 * 60_000;

const historial = new Map();
const diag = { muestras: 0, sinCambio: 0, ultLog: Date.now() };

const KX = 111320 * Math.cos((-34.64 * Math.PI) / 180);
const KY = 110540;
const distM = (a, b) => Math.hypot((a.long - b.long) * KX, (a.lat - b.lat) * KY);

function distEstacionCercanaM(p, coords) {
  let min = Infinity;
  for (const [lat, long] of coords) min = Math.min(min, distM(p, { lat, long }));
  return min;
}

function evaluar(e, coords) {
  const ult = e.m[e.m.length - 1];
  const base = e.m.find((x) => ult.t - x.t <= VENTANA_MS);
  const span = ult.t - base.t;
  if (span < MIN_SPAN_MS) return;
  e.vel = (distM(base, ult) / (span / 1000)) * 3.6;
  const dEst = distEstacionCercanaM(ult, coords);
  let cand;
  if (e.vel < UMBRAL_DETENIDO_KMH) cand = dEst <= RADIO_ESTACION_M ? "en_estacion" : "detenido_via";
  else if (e.vel < UMBRAL_LENTO_KMH && dEst > RADIO_APROX_M) cand = "lento";
  else cand = "normal";
  if (cand === e.cand) e.candN++; else { e.cand = cand; e.candN = 1; }
  if (e.candN >= CONFIRMAR) e.estado = cand;
}

// Agrega velKmh / marcha / gpsSinCambioS a cada tren (modifica el arreglo recibido).
export function actualizarMarcha(trenes, coords, ahora = Date.now()) {
  const conteo = {};
  for (const t of trenes) {
    t.velKmh = null; t.marcha = null; t.gpsSinCambioS = null;
    if (t.numero == null || t.cancelado || t.fuente !== "gps" || !t.gps) continue;
    let e = historial.get(t.numero);
    if (!e) { e = { m: [], vel: null, estado: null, cand: null, candN: 0, ultCambio: ahora, visto: ahora }; historial.set(t.numero, e); }
    e.visto = ahora;
    const last = e.m[e.m.length - 1];
    if (!last || ahora - last.t >= MIN_ENTRE_MUESTRAS_MS) {
      const nueva = { t: ahora, lat: t.gps.lat, long: t.gps.long };
      const movio = !last || distM(last, nueva) >= MOVIMIENTO_MIN_M;
      if (last) { diag.muestras++; if (!movio) diag.sinCambio++; }
      if (movio) e.ultCambio = ahora;
      e.m.push(nueva);
      while (e.m.length > MAX_MUESTRAS) e.m.shift();
      evaluar(e, coords);
    }
    t.velKmh = e.vel == null ? null : Math.round(e.vel * 10) / 10;
    t.marcha = e.estado;
    t.gpsSinCambioS = Math.round((ahora - e.ultCambio) / 1000);
    conteo[t.marcha || "sin_dato"] = (conteo[t.marcha || "sin_dato"] || 0) + 1;
  }
  for (const [k, e] of historial) if (ahora - e.visto > OLVIDAR_MS) historial.delete(k);
  if (ahora - diag.ultLog >= LOG_CADA_MS) {
    const pct = diag.muestras ? Math.round((diag.sinCambio / diag.muestras) * 100) : 0;
    console.log(`[marcha] ${diag.muestras} muestras en ${Math.round((ahora - diag.ultLog) / 60000)} min, ${pct}% sin cambio de coordenada · estados ahora: ${JSON.stringify(conteo)}`);
    diag.muestras = 0; diag.sinCambio = 0; diag.ultLog = ahora;
  }
  return trenes;
}
