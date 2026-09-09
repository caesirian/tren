// src/complaintTracker.js
// Señal AUXILIAR e informal: si el grupo está activo y nadie se queja de
// demoras/paro, es un indicio (no una confirmación) de que el servicio
// viene funcionando con normalidad. Nunca reemplaza al semáforo oficial
// de Firestore — solo suma contexto cuando no hay nada mejor.
//
// Se guarda en memoria (no en base de datos): al reiniciarse el servicio
// (Render free tier duerme y despierta) la ventana se reinicia sola, lo
// cual está bien para este propósito.

const VENTANA_MS = 45 * 60 * 1000; // 45 minutos
const MIN_MENSAJES_PARA_OPINAR = 5; // no decir nada con poca actividad

const PALABRAS_QUEJA = [
  "demora", "demorado", "atrasad", "tardanza", "no arranca", "no anda",
  "no llega", "no sale", "parado", "paro", "varad", "cortad", "corte",
  "falla", "rotura", "roto", "descarril", "choque", "chocó", "colapsad",
  "sin luz", "quedamos", "quedé", "no funciona", "suspendid", "cancelad",
];

// Ventana deslizante en memoria: [{ ts, esQueja }]
let mensajes = [];

function limpiarVentana(ahoraMs) {
  mensajes = mensajes.filter((m) => ahoraMs - m.ts < VENTANA_MS);
}

export function registrarMensajeGrupo(texto) {
  const ahoraMs = Date.now();
  limpiarVentana(ahoraMs);
  const lower = (texto || "").toLowerCase();
  const esQueja = PALABRAS_QUEJA.some((p) => lower.includes(p));
  mensajes.push({ ts: ahoraMs, esQueja });
}

// Devuelve la señal actual, o null si no hay actividad suficiente para opinar.
export function getSenalComunidad() {
  limpiarVentana(Date.now());
  const total = mensajes.length;
  if (total < MIN_MENSAJES_PARA_OPINAR) return null;

  const quejas = mensajes.filter((m) => m.esQueja).length;
  const minutos = Math.round(VENTANA_MS / 60000);

  let interpretacion;
  if (quejas === 0) {
    interpretacion = `Nadie mencionó demoras, paros ni problemas en los últimos ${minutos} minutos (${total} mensajes en el grupo) — indicio informal de que viene funcionando con normalidad, pero NO es una confirmación oficial.`;
  } else if (quejas === 1) {
    interpretacion = `Hubo 1 mensaje en los últimos ${minutos} minutos que podría sugerir un problema puntual, entre ${total} mensajes totales — no es concluyente, puede ser una queja aislada.`;
  } else {
    interpretacion = `Hubo ${quejas} mensajes en los últimos ${minutos} minutos que suenan a quejas de demoras o problemas, entre ${total} mensajes totales — señal de que podría haber inconvenientes, conviene confirmarlo.`;
  }

  return { total, quejas, minutos, interpretacion };
}
