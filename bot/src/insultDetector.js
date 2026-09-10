// src/insultDetector.js
// Detección simple por palabras clave de insultos/agravios en el grupo, para
// avisarle al admin. No es perfecto (no entiende sarcasmo ni insultos muy
// creativos), pero cubre los casos más comunes sin gastar cuota de Gemini
// analizando cada mensaje del grupo.

const PALABRAS_INSULTO = [
  "boludo", "boluda", "pelotudo", "pelotuda", "forro", "forra", "gil",
  "idiota", "estúpido", "estupido", "estúpida", "estupida", "imbécil", "imbecil",
  "andate a la mierda", "la puta que", "hijo de puta", "hija de puta",
  "concha de tu madre", "la concha", "andá a cagar", "anda a cagar",
  "sos un inútil", "sos una inútil", "sos un inutil", "sos un basura",
  "cornudo", "puto de mierda", "puta de mierda", "villero", "negro de mierda",
  "sorete", "garca", "chorro de mierda", "cagón", "cagon", "sos un pelotudo",
  "callate la boca", "cállate la boca", "and ate a la re mil", "reputa",
];

export function esInsulto(texto) {
  const lower = (texto || "").toLowerCase();
  return PALABRAS_INSULTO.some((p) => lower.includes(p));
}
