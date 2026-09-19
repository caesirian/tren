// src/respuestaDedupe.js
// Evita que el bot conteste lo mismo varias veces seguidas cuando responde
// "al aire" (sin que lo mencionen) en el grupo — si el mismo TEMA ya se
// contestó en los últimos 10 minutos o en los últimos 10 mensajes del
// grupo, se omite. Solo aplica al modo "al aire": si te mencionan
// directamente, el bot siempre contesta, no importa si es repetido.

const VENTANA_MS = 10 * 60 * 1000;
const VENTANA_MENSAJES = 10;
const LIMITE_MAX_MS = 90 * 60 * 1000; // pasado esto, contesta igual sin importar mensajes de por medio
const PODA_MS = LIMITE_MAX_MS; // no podar antes de que el tope de arriba pueda aplicar

// Agrupa palabras relacionadas bajo un mismo tema — así "¿anda el
// servicio?" y "¿está funcionando?" cuentan como la misma pregunta a
// efectos de no repetirse, aunque usen palabras distintas.
const CATEGORIAS = {
  estado: [
    "servicio", "funciona", "funcionando", "circula", "circulando",
    "demora", "demorado", "parado", "paro", "huelga", "gremial",
    "gremiales", "cese", "medida de fuerza", "suspendido", "suspendida",
    "cancelado", "cancelada", "cancelaron", "esperando", "espera",
  ],
  horarios: ["horario", "horarios", "frecuencia", "frecuencias", "primer tren", "último tren", "ultimo tren"],
  tarifas: ["tarifa", "tarifas", "boleto", "boletos", "sube"],
  objetosPerdidos: ["perdí", "perdi", "perdido", "perdida", "encontré", "encontre", "encontrado", "objeto", "mochila", "celular", "olvidé", "olvide"],
};

let historial = []; // { tema, ts, seq }
let contadorMensajes = 0;

export function incrementarContadorMensajes() {
  contadorMensajes++;
}

// Devuelve el tema detectado, o null si el texto no cae en ninguna
// categoría agrupable (en ese caso nunca se considera "repetida").
export function detectarTema(textoOriginal) {
  const lower = (textoOriginal || "").toLowerCase();
  for (const [tema, palabras] of Object.entries(CATEGORIAS)) {
    if (palabras.some((p) => lower.includes(p))) return tema;
  }
  return null;
}

export function yaRespondidoRecientemente(tema) {
  if (!tema) return false;
  const ahora = Date.now();
  historial = historial.filter((h) => ahora - h.ts < PODA_MS);
  return historial.some((h) => {
    if (h.tema !== tema) return false;
    if (ahora - h.ts >= LIMITE_MAX_MS) return false; // pasaron 90+ min: contesta igual
    return ahora - h.ts < VENTANA_MS || contadorMensajes - h.seq < VENTANA_MENSAJES;
  });
}

export function registrarRespuestaAlAire(tema) {
  if (!tema) return;
  historial.push({ tema, ts: Date.now(), seq: contadorMensajes });
}

// Cuando entra información nueva y más fiable (ej. un aviso de la fuente de
// verdad), lo que el bot contestó antes sobre ese tema quedó viejo: se borra
// para que la próxima pregunta al aire se conteste con el dato actualizado.
export function olvidarTema(tema) {
  if (!tema) return;
  historial = historial.filter((h) => h.tema !== tema);
}
