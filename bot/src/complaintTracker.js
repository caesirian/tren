// src/complaintTracker.js
// Señal AUXILIAR e informal del grupo: categoriza cada mensaje como
// "demora", "cancelacion", "normalidad" (reporte explícito de que anda
// bien) o ninguna de las tres (charla neutra, no cuenta para nada).
// Nunca reemplaza al semáforo oficial de Firestore — solo suma contexto
// cuando no hay nada mejor, y alimenta el resumen de última hora del
// /informe.
//
// Se guarda en memoria (no en base de datos): al reiniciarse el servicio
// (Render free tier duerme y despierta) la ventana se reinicia sola, lo
// cual está bien para este propósito — es señal de corto plazo, no
// histórico.

const VENTANA_SENAL_MS = 3 * 60 * 60 * 1000; // 3 horas, para responder preguntas de estado
const VENTANA_RESUMEN_MS = 60 * 60 * 1000; // 1 hora, para el resumen del /informe
const MIN_MENSAJES_PARA_OPINAR = 5; // solo aplica para decir "viene todo bien"

const PALABRAS_DEMORA = [
  "demora", "demorado", "atrasad", "tardanza", "tardando", "tarda ", "tardó",
  "no arranca", "no anda", "no llega", "no sale", "parado", "varad",
  "espera", "esperando", "esperamos", "20 min", "media hora", "hora esperando",
];
const PALABRAS_CANCELACION = [
  "cancela", "suspendid", "paro", "cortad", "corte", "no funciona",
  "descarril", "choque", "chocó", "colapsad", "sin luz", "quedamos",
  "quedé", "falla", "rotura", "roto",
];
const PALABRAS_NORMALIDAD = [
  "anda bien", "todo bien", "llegó a horario", "llegue a horario",
  "llegó puntual", "a horario", "sin problemas", "sin demoras",
  "ninguna demora", "viene normal", "anda normal", "todo normal",
  "puntual",
];

function categorizar(texto) {
  const lower = (texto || "").toLowerCase();
  // Cancelación y demora pesan más que "normalidad" ante cualquier
  // superposición de palabras — mejor sobre-reportar un problema que
  // taparlo con un falso "todo bien".
  if (PALABRAS_CANCELACION.some((p) => lower.includes(p))) return "cancelacion";
  if (PALABRAS_DEMORA.some((p) => lower.includes(p))) return "demora";
  if (PALABRAS_NORMALIDAD.some((p) => lower.includes(p))) return "normalidad";
  return null;
}

// Ventana deslizante en memoria: [{ ts, userId, categoria }]
let mensajes = [];

function limpiarVentana(ahoraMs) {
  mensajes = mensajes.filter((m) => ahoraMs - m.ts < VENTANA_SENAL_MS);
}

export function registrarMensajeGrupo(texto, userId) {
  const ahoraMs = Date.now();
  limpiarVentana(ahoraMs);
  mensajes.push({ ts: ahoraMs, userId: userId ?? null, categoria: categorizar(texto) });
}

// Devuelve la señal actual (ventana de 3hs), o null si no hay nada útil
// para opinar. Usada para contestar preguntas de estado del servicio.
export function getSenalComunidad() {
  limpiarVentana(Date.now());
  const total = mensajes.length;
  const quejas = mensajes.filter((m) => m.categoria === "demora" || m.categoria === "cancelacion").length;
  const minutos = Math.round(VENTANA_SENAL_MS / 60000);

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

// Resumen de la última hora para el /informe: cuántas CUENTAS DISTINTAS
// reportaron cada categoría (no cuenta mensajes repetidos de la misma
// persona, para que un solo usuario insistente no infle el número).
export function getResumenUltimaHora() {
  const ahoraMs = Date.now();
  const ventana = mensajes.filter((m) => ahoraMs - m.ts < VENTANA_RESUMEN_MS);

  const usuariosPorCategoria = { demora: new Set(), cancelacion: new Set(), normalidad: new Set() };
  for (const m of ventana) {
    if (m.categoria && usuariosPorCategoria[m.categoria]) {
      usuariosPorCategoria[m.categoria].add(m.userId ?? `anon-${m.ts}`);
    }
  }

  return {
    totalMensajes: ventana.length,
    cuentasDemora: usuariosPorCategoria.demora.size,
    cuentasCancelacion: usuariosPorCategoria.cancelacion.size,
    cuentasNormalidad: usuariosPorCategoria.normalidad.size,
  };
}
