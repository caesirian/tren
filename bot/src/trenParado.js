// src/trenParado.js
// Preguntas del tipo "¿por qué hay un tren parado en Haedo?", "¿qué pasa que
// el tren no se mueve?". Solo se contestan si alguna fuente viva (aviso de la
// fuente de verdad, estado del servicio, alertas de la API, comunicados o el
// estado en vivo de la app) confirma que hay un tren detenido. Si no hay dato,
// el bot NO responde nada (ni al aire ni directo): a pedido del admin (oct
// 2026) no quiere respuestas negativas tipo "no veo ningún tren parado".
//
// Si algún día se prefiere contestar cuando lo mencionan directo, alcanza con
// condicionar el silencio a `!fueEtiquetado` en index.js.

const sinAcentos = (t) => (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// El tren/formación/servicio como sujeto.
const SUJETO = "(?:tren|trenes|formacion|formaciones|servicio|local|diferencial|coche|coches|tren de [a-z ]{3,20})";
// Estar detenido.
const DETENIDO =
  "(?:parad[oa]s?|detenid[oa]s?|frenad[oa]s?|varad[oa]s?|clavad[oa]s?|quiet[oa]s?|inmovilizad[oa]s?|sin\\s+(?:moverse|avanzar|arrancar|salir)|no\\s+(?:se\\s+mueve|avanza|arranca|sale|anda|camina)|hace\\s+(?:rato|mucho)\\s+(?:que\\s+)?(?:esta|estamos)\\s+(?:ahi|aca|parad[oa]s?))";
// Pedir el motivo.
const MOTIVO = "(?:por\\s*que|porque|que\\s+(?:pasa|paso|ocurre|le\\s+pasa|hay)|alguien\\s+sabe|motivo|razon|a\\s+que\\s+se\\s+debe|como\\s+es\\s+que)";

const RE_SUJETO_DETENIDO = new RegExp(`\\b${SUJETO}\\b[^.!?\\n]{0,60}\\b${DETENIDO}`);
const RE_DETENIDO_SUJETO = new RegExp(`\\b${DETENIDO}\\b[^.!?\\n]{0,60}\\b${SUJETO}\\b`);
const RE_MOTIVO = new RegExp(`\\b${MOTIVO}\\b`);

// ¿Es una consulta sobre por qué hay un tren parado?
export function esConsultaTrenParado(texto) {
  const t = sinAcentos(texto);
  if (!RE_MOTIVO.test(t)) return false;
  return RE_SUJETO_DETENIDO.test(t) || RE_DETENIDO_SUJETO.test(t);
}

// ¿Algún texto de las fuentes vivas habla de un tren detenido o de una causa
// que lo explique (falla, persona en vías, tercer riel, etc.)?
const RE_DATO =
  /\b(parad[oa]s?|detenid[oa]s?|detencion|varad[oa]s?|inmovilizad[oa]s?|sin\s+movimiento|no\s+avanza|interrump\w*|interrupcion|corte\s+de\s+servicio|falla|averia\w*|desperfecto\w*|problema\s+tecnico|persona\s+(?:en|sobre)\s+(?:las\s+)?vias?|arrollad\w*|accidente|colision|siniestro|tercer\s+riel|catenaria|cable\w*|senaliz\w*|obstaculo|objeto\s+en\s+(?:las\s+)?vias?|hecho\s+de\s+inseguridad|robo\s+de\s+cable\w*)\b/;

export function mencionaTrenParado(...textos) {
  return RE_DATO.test(sinAcentos(textos.filter(Boolean).join(" ")));
}
