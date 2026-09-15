// src/retryQueue.js
// Cola en memoria de preguntas que fallaron por un error TRANSITORIO
// (Gemini saturado: 429/503/RESOURCE_EXHAUSTED/UNAVAILABLE). El ping
// periódico (/internal/check, cada 10-15 min) reintenta cada una; si
// Gemini responde esta vez, la respuesta se le manda igual a quien
// preguntó (aunque haya pasado un rato), sin que tenga que volver a
// escribir. Si se cae el proceso (Render duerme/reinicia) la cola se
// pierde — es un mejor-esfuerzo, no una garantía dura; para eso está el
// aviso inmediato al admin (ver index.js) que sí queda en Firestore.

const MAX_INTENTOS = 5;
const MAX_EDAD_MS = 3 * 60 * 60 * 1000; // 3 horas — pasado esto, se descarta

let cola = [];

export function encolarReintento(item) {
  cola.push({ ...item, intentos: 0, agregadoEn: Date.now() });
}

// Devuelve los ítems pendientes y limpia los vencidos/agotados de la cola.
// El llamador debe volver a llamar a quitarDeCola() por cada uno que
// procese (haya tenido éxito o no), para no reprocesarlo dos veces.
export function listaPendientes() {
  const ahora = Date.now();
  cola = cola.filter((item) => ahora - item.agregadoEn < MAX_EDAD_MS && item.intentos < MAX_INTENTOS);
  return [...cola];
}

export function marcarIntento(item) {
  const enCola = cola.find((i) => i === item);
  if (enCola) enCola.intentos++;
}

export function quitarDeCola(item) {
  cola = cola.filter((i) => i !== item);
}

export function tamanoCola() {
  return cola.length;
}
