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

const VENTANA_SENAL_MS = 3 * 60 * 60 * 1000; // retención en memoria (la usa el semáforo automático, hasta 90 min)
const VENTANA_RESPUESTA_MS = 60 * 60 * 1000; // 1 hora: lo único que cuenta para contestar preguntas de estado
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

// Devuelve la señal actual (ventana de 1 hora), o null si no hay nada útil
// para opinar. Usada para contestar preguntas de estado del servicio. Los
// reclamos más viejos que la ventana NO cuentan (aunque sigan en memoria para
// el semáforo automático). Las quejas se cuentan por cuentas distintas.
export function getSenalComunidad() {
  const ahoraMs = Date.now();
  limpiarVentana(ahoraMs);
  const ventana = mensajes.filter((m) => ahoraMs - m.ts < VENTANA_RESPUESTA_MS);
  const total = ventana.length;
  const cuentasQueja = new Set(
    ventana
      .filter((m) => m.categoria === "demora" || m.categoria === "cancelacion")
      .map((m) => m.userId ?? `anon-${m.ts}`)
  );
  const quejas = cuentasQueja.size;
  const minutos = Math.round(VENTANA_RESPUESTA_MS / 60000);

  if (quejas === 0 && total < MIN_MENSAJES_PARA_OPINAR) return null;

  let interpretacion;
  if (quejas === 0) {
    interpretacion = `Nadie mencionó demoras, esperas, paros ni problemas en los últimos ${minutos} minutos (${total} mensajes en el grupo) — indicio informal de que viene funcionando con normalidad, pero NO es una confirmación oficial.`;
  } else if (quejas === 1) {
    interpretacion = `1 persona mencionó algo que podría sugerir un problema puntual en los últimos ${minutos} minutos, entre ${total} mensajes totales — no es concluyente, puede ser una queja aislada. NO lo menciones como "reportes de demoras en el grupo" si el estado oficial es normal.`;
  } else {
    interpretacion = `${quejas} personas distintas escribieron en los últimos ${minutos} minutos mensajes que suenan a quejas de demoras, esperas o cancelaciones, entre ${total} mensajes totales — señal de que podría haber inconvenientes. Si preguntan por el estado del servicio, mencioná esto (aclarando que es una señal informal del grupo, no una confirmación oficial). Nunca digas que "se reportan demoras" por hechos anteriores a esos ${minutos} minutos.`;
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

// Cuentas DISTINTAS que reportaron demora o cancelación en los últimos
// `ventanaMs` (una persona insistente cuenta una sola vez). Lo usa el semáforo
// automático (estadoAuto.js). Es en memoria: se reinicia con el servicio.
export function getQuejasRecientes(ventanaMs) {
  const ahoraMs = Date.now();
  const cuentas = new Set();
  for (const m of mensajes) {
    if (ahoraMs - m.ts >= ventanaMs) continue;
    if (m.categoria === "demora" || m.categoria === "cancelacion") cuentas.add(m.userId ?? `anon-${m.ts}`);
  }
  return cuentas.size;
}
