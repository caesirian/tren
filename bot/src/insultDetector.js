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
  "callate la boca", "cállate la boca", "reputa",
  // Groserías generales (no necesariamente dirigidas a una persona puntual)
  "mierda", "carajo", "la concha de la lora", "pelotudez", "cagada",
  "qué cagada", "que cagada", "hijo de re mil putas", "puto", "puta madre",
];

// Uso "límite de palabra" manual (en vez de String.includes) para que
// "gil" no dispare con "frágil"/"vigilante", ni "reputa" con "reputado".
// \b de JS no reconoce vocales acentuadas como parte de una palabra, así que
// definimos manualmente qué cuenta como "letra" en español.
function contieneComoPalabra(texto, frase) {
  const escapada = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|[^a-zA-ZÀ-ÿ0-9])${escapada}([^a-zA-ZÀ-ÿ0-9]|$)`, "i");
  return regex.test(texto);
}

export function esInsulto(texto) {
  if (!texto) return false;
  return PALABRAS_INSULTO.some((p) => contieneComoPalabra(texto, p));
}
