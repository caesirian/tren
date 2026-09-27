// src/colectivoSearch.js
// Búsqueda web EN VIVO para preguntas sobre líneas de colectivo (recorrido,
// frecuencia, si combina con tal estación, etc.) — no tenemos esa info
// cargada a mano como con el tren, así que acá sí vale la pena una búsqueda
// real. Mismo mecanismo que paroSearch.js (grounding con Google Search de
// la API de Gemini), cacheado por consulta para no repetir búsquedas
// idénticas seguidas.

import { GoogleGenAI } from "@google/genai";
import NodeCache from "node-cache";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.6-flash";

// 6 horas: los recorridos/frecuencias de colectivos no cambian de un
// momento a otro, así que se puede cachear más tiempo que lo de paros.
const cache = new NodeCache({ stdTTL: 6 * 60 * 60 });

export async function consultarColectivoEnVivo(pregunta) {
  const clave = pregunta.trim().toLowerCase().slice(0, 200);
  const cacheado = cache.get(clave);
  if (cacheado) return { ...cacheado, deCache: true };

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents:
        `Buscá información actual y precisa para responder esta pregunta sobre transporte público del AMBA (Buenos Aires), Argentina: "${pregunta}". ` +
        `Es probablemente sobre una línea de colectivo (recorrido, frecuencia, combinación con una estación de tren, horarios). ` +
        `Respondé en español rioplatense, en 2-4 líneas, con la info más concreta que encuentres (número de línea, recorrido, frecuencia aproximada). ` +
        `Si no encontrás nada confiable, decilo con claridad en vez de inventar un dato.`,
      tools: [{ googleSearch: {} }],
    });

    const texto = response.text.trim();
    const resultado = { texto, buscadoEn: new Date().toISOString() };
    cache.set(clave, resultado);
    return { ...resultado, deCache: false };
  } catch (err) {
    console.error("Error buscando info de colectivo en vivo:", err.message);
    return null;
  }
}
