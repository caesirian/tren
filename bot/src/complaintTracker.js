// src/complaintTracker.js
// Señal AUXILIAR e informal: si el grupo está activo y nadie se queja de
// demoras/paro, es un indicio (no una confirmación) de que el servicio
// viene funcionando con normalidad. Nunca reemplaza al semáforo oficial
// de Firestore — solo suma contexto cuando no hay nada mejor.
//
// Se guarda en memoria (no en base de datos): al reiniciarse el servicio
// (Render free tier duerme y despierta) la ventana se reinicia sola, lo
// cual está bien para este propósito.

const VENTANA_MS = 3 * 60 * 60 * 1000; // 3 horas — para que las quejas de
// "hoy más temprano" sigan pesando cuando preguntan por el estado más tarde.
const MIN_MENSAJES_PARA_OPINAR = 5; // solo aplica para decir "viene todo bien"

const PALABRAS_QUEJA = [
  "demora", "demorado", "atrasad", "tardanza", "tardando", "tarda ", "tardó",
  "no arranca", "no anda", "no llega", "no sale", "parado", "paro", "varad",
  "cortad", "corte", "falla", "rotura", "roto", "descarril", "choque",
  "chocó", "colapsad", "sin luz", "quedamos", "quedé", "no funciona",
  "suspendid", "cancela", "espera", "esperando", "esperamos", "20 min",
  "media hora", "hora esperando",
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

// Devuelve la señal actual, o null si no hay nada útil para opinar.
export function getSenalComunidad() {
  limpiarVentana(Date.now());
  const total = mensajes.length;
  const quejas = mensajes.filter((m) => m.esQueja).length;
  const minutos = Math.round(VENTANA_MS / 60000);

  // Si NO hay quejas, solo vale la pena opinar con actividad suficiente
  // (poca charla no alcanza para decir "todo normal"). Si SÍ hay quejas,
  // valen igual aunque sean pocos mensajes en total — 1 o 2 quejas ya son
  // información, no hace falta esperar a que haya mucho tráfico.
  if (quejas === 0 && total < MIN_MENSAJES_PARA_OPINAR) return null;

  let interpretacion;
  if (quejas === 0) {
    interpretacion = `Nadie mencionó demoras, esperas, paros ni problemas en los últimos ${minutos} minutos (${total} mensajes en el grupo) — indicio informal de que viene funcionando con normalidad, pero NO es una confirmación oficial.`;
  } else if (quejas === 1) {
    interpretacion = `Hubo 1 mensaje en los últimos ${minutos} minutos que podría sugerir un problema puntual, entre ${total} mensajes totales — no es concluyente, puede ser una queja aislada.`;
  } else {
    interpretacion = `Hubo ${quejas} mensajes en los últimos ${minutos} minutos que suenan a quejas de demoras, esperas o cancelaciones, entre ${total} mensajes totales — señal de que podría haber inconvenientes. Si preguntan por el estado del servicio, MENCIONÁ esto explícitamente (aclarando que es una señal informal del grupo, no una confirmación oficial), no lo omitas.`;
  }

  return { total, quejas, minutos, interpretacion };
}
