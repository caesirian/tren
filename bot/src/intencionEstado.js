// src/intencionEstado.js
// Detecta si la pregunta es SOLO sobre cómo está el servicio AHORA ("cómo anda
// el tren", "cómo funciona el servicio", "hay demoras"). En ese caso el bot
// no debe recibir la ficha del ramal (horarios de operación, frecuencias,
// cambios de fin de semana): Gemini la usa de relleno y la gente la lee como
// "anda siempre", que no es lo que preguntó.

const RE_ESTADO = new RegExp(
  [
    // "cómo anda/está/funciona/va/viene (el tren | el servicio | todo | ...)"
    String.raw`c[oó]mo\s+(anda|andan|est[aá]|est[aá]n|va|van|funciona|funcionan|viene|vienen|sigue|siguen|salieron|salen)(?![\wáéíóúñ])`,
    // "qué tal el tren / el servicio"
    String.raw`qu[eé]\s+tal\s+(el\s+)?(tren|trenes|servicio|sarmiento)`,
    // "hay servicio / hay demoras / hay problemas / hay novedades"
    String.raw`\bhay\s+(servicio|demoras?|problemas?|novedades|cancelaciones)\b`,
    // "anda el tren / funciona el servicio / está funcionando"
    String.raw`\b(anda|funciona)\s+(el\s+)?(tren|trenes|servicio|sarmiento)\b`,
    String.raw`\best[aá]\s+funcionando\b`,
    // "el servicio está normal / el tren está demorado"
    String.raw`\b(servicio|tren|trenes)\s+(est[aá]|anda|van?)\s+(normal|bien|mal|demorad|con demoras)`,
  ].join("|"),
  "i"
);

// Si además piden horarios, tarifas, estaciones, locales, etc., NO es solo estado:
// el contexto completo sí hace falta.
const RE_PIDE_OTRA_COSA =
  /horario|a\s+qu[eé]\s+hora|frecuencia|cada\s+cu[aá]nto|cu[aá]ndo\s+(pasa|sale|llega)|pr[oó]ximo|primer(o)?\s+tren|[uú]ltimo\s+tren|tarifa|precio|cu[aá]nto\s+sale|boleto|diferencial|preferencial|\blocal(es)?\b|colectivo|combinaci[oó]n|subte|noticia|objeto|perdid|\bparo\b|huelga|obra|fin\s+de\s+semana|finde|s[aá]bado|domingo|ma[nñ]ana|ayer/i;

export function esConsultaDeEstado(pregunta) {
  const p = String(pregunta || "");
  return RE_ESTADO.test(p) && !RE_PIDE_OTRA_COSA.test(p);
}
