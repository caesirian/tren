// src/tableroOnce.js
// Detecta cuando alguien pregunta cómo están saliendo los trenes de Once
// ("¿cómo están saliendo los trenes de Once?", "¿salen trenes de Once?",
// "alguien sabe si están saliendo de Once"). En ese caso el bot comparte solo
// el tablero de Once y deja el ancla del tablero del sitio.

export const LINK_TABLERO = "https://trensarmientoenlinea.com.ar/#tablero";

function normalizar(texto) {
  return (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function esConsultaSalidasOnce(texto) {
  const t = normalizar(texto);
  // Tiene que hablar de salidas "de/desde Once" (no "de Moreno a Once", "llegando a Once").
  if (!/\b(de|desde)\s+once\b/.test(t)) return false;
  const habla_de_salidas = /\b(sal(e|en|ia|ian|iendo|ida|idas|go|ieron)|parte|parten|partiendo|partida|partidas)\b/.test(t);
  const habla_de_trenes = /\b(tren|trenes|formacion|formaciones|servicio|nada|algo)\b/.test(t);
  if (!habla_de_salidas || !habla_de_trenes) return false;
  // "¿Cuánto sale el tren de Once a Moreno?" es una pregunta de tarifa, no de salidas.
  if (/\b(cuanto|precio|tarifa|boleto|pasaje|sube|cuesta)\b/.test(t)) return false;
  // Tiene que ser una pregunta (no un comentario como "salieron bien de Once").
  const esPregunta = /[?¿]/.test(t) || /(^|[^a-z])(como|cuando|cuanto|donde|hay|sabe|alguien|que tal)([^a-z]|$)/.test(t);
  return esPregunta;
}
