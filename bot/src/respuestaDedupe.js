// src/respuestaDedupe.js
// Evita que el bot conteste lo mismo varias veces seguidas cuando responde
// "al aire" (sin que lo mencionen) en el grupo — si el mismo TEMA ya se
// contestó en los últimos 10 minutos o en los últimos 10 mensajes del
// grupo, se omite. Solo aplica al modo "al aire": si te mencionan
// directamente, el bot siempre contesta, no importa si es repetido.

const VENTANA_MS = 10 * 60 * 1000;
const VENTANA_MENSAJES = 10;
// Estado general y horarios: el bot respondía demasiado seguido y resultaba
// molesto (admin, oct 2026). Si ya se contestó el tema en los últimos
// VENTANA_ESPACIADA_MS, no vuelve a contestar solo al aire; recién si el
// usuario que preguntó sigue sin respuesta (de nadie) tras ESPERA_SIN_RESPUESTA_MS,
// el bot contesta igual.
const TEMAS_ESPACIADOS = new Set(["estado", "horarios"]);
const VENTANA_ESPACIADA_MS = 30 * 60 * 1000;
const ESPERA_SIN_RESPUESTA_MS = 10 * 60 * 1000;
// Respuestas al aire en general (cualquier tema): el bot contestaba al
// instante y una atrás de otra. Ahora espera ESPERA_AL_AIRE_MS antes de
// contestar (por si alguien del grupo se adelanta) y, tras contestar al aire,
// no vuelve a hacerlo solo durante COOLDOWN_AL_AIRE_MS. Si lo mencionan, nada de
// esto aplica.
export const ESPERA_AL_AIRE_MS = 60 * 1000;
const COOLDOWN_AL_AIRE_MS = 5 * 60 * 1000;
let ultimoAlAireMs = 0;

export function enfriandoAlAire() {
  return Date.now() - ultimoAlAireMs < COOLDOWN_AL_AIRE_MS;
}

// Reserva el turno al aire mientras se arma la respuesta (evita que dos
// preguntas que vencen casi juntas contesten ambas). Devuelve una función para
// liberarlo si al final el bot no contestó nada.
export function reservarAlAire() {
  const previo = ultimoAlAireMs;
  const marca = Date.now();
  ultimoAlAireMs = marca;
  return () => {
    if (ultimoAlAireMs === marca) ultimoAlAireMs = previo;
  };
}

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
  if (TEMAS_ESPACIADOS.has(tema)) return historial.some((h) => h.tema === tema && ahora - h.ts < VENTANA_ESPACIADA_MS);
  return historial.some((h) => {
    if (h.tema !== tema) return false;
    if (ahora - h.ts >= LIMITE_MAX_MS) return false; // pasaron 90+ min: contesta igual
    return ahora - h.ts < VENTANA_MS || contadorMensajes - h.seq < VENTANA_MENSAJES;
  });
}

export function registrarRespuestaAlAire(tema) {
  ultimoAlAireMs = Date.now(); // cuenta para el enfriamiento general, tenga tema o no
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

export function esTemaEspaciado(tema) {
  return TEMAS_ESPACIADOS.has(tema);
}

// ---- Respuesta diferida: "si ese usuario no tuvo respuesta en 10 minutos, el bot contesta" ----
// Cada pregunta al aire omitida por tema espaciado queda pendiente. Se resuelve
// (y el bot NO contesta) si alguien le responde al mensaje (reply de una persona
// o del bot) o si el bot le contesta a ese usuario por otro camino. Los timers
// viven en memoria: si Render reinicia, el pendiente se pierde y el bot queda callado.
const pendientes = new Map(); // `${chatId}:${msgId}` -> { chatId, userId, timer }

export function programarRespuestaDiferida({ chatId, msgId, userId, alVencer, esperaMs = ESPERA_SIN_RESPUESTA_MS }) {
  const clave = `${chatId}:${msgId}`;
  if (pendientes.has(clave)) return false;
  // Un usuario con una pregunta pendiente en el chat no suma otra.
  for (const p of pendientes.values()) if (p.chatId === chatId && p.userId === userId) return false;
  const timer = setTimeout(() => {
    pendientes.delete(clave);
    Promise.resolve(alVencer()).catch((err) => console.error("Error en respuesta diferida:", err.message));
  }, esperaMs);
  timer.unref?.();
  pendientes.set(clave, { chatId, userId, timer });
  return true;
}

export function marcarRespondidoMensaje(chatId, msgId) {
  const clave = `${chatId}:${msgId}`;
  const p = pendientes.get(clave);
  if (!p) return;
  clearTimeout(p.timer);
  pendientes.delete(clave);
}

export function marcarRespondidoUsuario(chatId, userId) {
  if (userId == null) return;
  for (const [clave, p] of pendientes) {
    if (p.chatId === chatId && p.userId === userId) {
      clearTimeout(p.timer);
      pendientes.delete(clave);
    }
  }
}
