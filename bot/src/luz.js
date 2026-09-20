// src/luz.js
// Preguntas sobre si hay luz / energía / tensión ("¿hay luz en Once?", "¿se
// cortó la luz?"). Es un dato que el bot NO puede deducir: solo lo sabe si
// alguna fuente viva (aviso de la fuente de verdad, semáforo, alertas de la
// API o un comunicado) lo menciona. Sin dato, al aire se queda callado y, si
// le preguntan directo, lo dice con honestidad. Nunca lo infiere de que el
// servicio figure como "normal".

const sinAcentos = (t) => (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const SUST = "(?:luz(?!\\s+(?:verde|roja|amarilla))|energia|electricidad|corriente|tension)";
const RE_HAY = new RegExp(`\\b(?:hay|habra|tienen|tiene|volvio|volvieron|vuelve|llego)\\s+(?:la\\s+)?${SUST}\\b`);
const RE_SIN = new RegExp(`\\b(?:sin|falta de|corte de|cortaron|se corto|se fue|se cayo|se apago|se corta)\\s+(?:la\\s+)?${SUST}\\b`);
const RE_APAGON = /\bapagon\b/;

export function esConsultaDeLuz(texto) {
  const t = sinAcentos(texto);
  return RE_HAY.test(t) || RE_SIN.test(t) || RE_APAGON.test(t);
}

// ¿Algún texto de las fuentes vivas habla de luz/energía?
const RE_DATO = /\b(luz|energia|electric\w*|corriente|tension|catenaria|apagon|subestacion|alimentacion)\b/;
export function mencionaEnergia(...textos) {
  return RE_DATO.test(sinAcentos(textos.filter(Boolean).join(" ")));
}

export const RESPUESTA_SIN_DATO_LUZ =
  "No tengo información sobre si hay luz o energía en la estación o en el tramo ahora mismo, y prefiero no adivinar. Si hay un corte, se va a reflejar en el estado del servicio: https://trensarmientoenlinea.com.ar/#estado";
