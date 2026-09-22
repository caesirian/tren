// src/ocupacion.js
// Preguntas sobre cuánta gente hay AHORA en una estación o tren ("¿hay mucha
// gente en Once?", "¿viene lleno el tren?", "¿hay cola en la boletería?").
// Quien pregunta espera que le conteste alguien que esté ahí, viendo la
// estación. El bot no tiene cámaras ni datos de ocupación, así que no debe
// contestar esto al aire, ni estimarlo por horario pico.
//
// Si algún día el bot accede a las cámaras de las estaciones, alcanza con
// dejar de llamar a esOcupacionEnVivo() en index.js.

const sinAcentos = (t) => (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const ESTACIONES = "once|caballito|flores|floresta|villa luro|liniers|ciudadela|ramos mejia|haedo|moron|castelar|ituzaingo|padua|merlo|paso del rey|moreno";
const LUGAR = new RegExp(`\\b(tren|trenes|estacion|anden|boleteria|boleterias|molinete|molinetes|coche|coches|vagon|vagones|formacion|puente|${ESTACIONES})\\b`);

// Frases que por sí solas hablan de cuánta gente hay.
// (no cuenta si preguntan por estadísticas: "cuánta gente viaja por día")
const RE_GENTE = /\b(mucha|poca|bastante|cuanta|tanta|demasiada)\s+gente\b(?!\s+(viaja|transporta|usa|utiliza|toma)\b)|\bhay\s+gente\b|\bcantidad de gente\b|\bgente\s+(en|esperando|para subir)\b/;
// "Lleno", "explotado", etc.: solo cuentan si hablan de un tren o estación.
const RE_LLENO = /\b(lleno|llena|llenos|llenas|repleto|repleta|explotado|explotada|explotando|colmado|colmada|atestado|atestada|apretad[oa]s?|rebalsa\w*|sardinas)\b/;
// Colas/multitudes: también necesitan un lugar.
const RE_COLA = /\b(cola|colas|fila|filas|tumulto|aglomeracion\w*|multitud|hacinad[oa]s?)\b/;
// La frase inversa: "hay espacio/lugar", "va vacío", "viene despejado" —
// es la misma pregunta de ocupación, solo que en positivo.
const RE_ESPACIO = /\b(hay|queda|quedan|tiene|con)\s+(espacio|lugar|lugares|asientos?)\b|\b(sin\s+gente|va\s+vaci[oa]|viene\s+vaci[oa]|va\s+desped?jad[oa]|viene\s+desped?jad[oa])\b/;
// "Vacío/despejado": solo cuentan si hablan de un tren o estación (si no,
// "tengo la heladera vacía" también matchearía).
const RE_VACIO_LUGAR = /\b(vaci[oa]s?|desped?jad[oa]s?)\b/;

export function esOcupacionEnVivo(texto) {
  const t = sinAcentos(texto);
  if (RE_GENTE.test(t)) return true;
  if (RE_ESPACIO.test(t)) return true;
  if ((RE_LLENO.test(t) || RE_COLA.test(t) || RE_VACIO_LUGAR.test(t)) && LUGAR.test(t)) return true;
  return false;
}

// Respuesta cuando alguien le pregunta esto DIRECTO al bot (mención, reply o
// chat privado): se dice con honestidad, sin inventar. Al aire no se responde.
export const RESPUESTA_SIN_CAMARAS =
  "No tengo cámaras ni forma de ver cuánta gente hay en la estación o en el tren ahora mismo 🙈 Eso te lo puede contar mejor alguien que esté ahí. Lo que sí te puedo decir es el estado del servicio y los horarios.";
