// src/rateLimiter.js
// Límite simple por usuario para que nadie (sin querer o queriendo) le gaste
// toda la cuota gratuita de Gemini al bot en pocos minutos. En memoria, no
// necesita base de datos — se resetea solo si el servicio se reinicia.

const LIMITE_PREGUNTAS = 8;
const VENTANA_MS = 10 * 60 * 1000; // 10 minutos

const historialPorUsuario = new Map(); // userId -> [timestamps]

// Devuelve true si el usuario ya se pasó del límite en la ventana actual.
// Registra la pregunta actual como parte del conteo.
export function excedioLimite(userId) {
  const ahora = Date.now();
  const historial = (historialPorUsuario.get(userId) || []).filter(
    (t) => ahora - t < VENTANA_MS
  );
  historial.push(ahora);
  historialPorUsuario.set(userId, historial);
  return historial.length > LIMITE_PREGUNTAS;
}
