// src/paroSearch.js
// Búsqueda web EN VIVO, pero solo para paros/medidas gremiales — es el único
// caso donde vale la pena gastar cuota extra en una búsqueda real, porque es
// información que cambia día a día y no se puede cargar a mano con
// anticipación confiable. Para todo lo demás (horarios, tarifas, AMBA en
// general) seguimos usando datos cargados a mano.
//
// Usa la búsqueda de Google integrada en la API de Gemini (grounding), y
// cachea el resultado unas horas para no volver a buscar en cada pregunta.

import { GoogleGenAI } from "@google/genai";
import NodeCache from "node-cache";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.6-flash";

// 3 horas: suficiente para no repetir la búsqueda en preguntas seguidas del
// mismo día, pero corto para no arrastrar una noticia vieja demasiado tiempo.
const cache = new NodeCache({ stdTTL: 3 * 60 * 60 });
const CACHE_KEY = "estado_paro_amba";

export async function consultarParoEnVivo() {
  const cacheado = cache.get(CACHE_KEY);
  if (cacheado) return { ...cacheado, deCache: true };

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents:
        `Buscá información actual sobre si hay algún paro, huelga o medida ` +
        `de fuerza gremial que afecte hoy o en los próximos días al ` +
        `transporte público en Argentina, especialmente trenes y en ` +
        `particular el ramal Sarmiento (Once-Moreno). Respondé en español ` +
        `rioplatense, en 2-4 líneas, con la info más concreta que ` +
        `encuentres (gremio, fecha, alcance, motivo). Si no encontrás nada ` +
        `relevante o vigente, decilo con claridad en vez de especular.`,
      tools: [{ googleSearch: {} }],
    });

    const texto = response.text.trim();
    const resultado = { texto, buscadoEn: new Date().toISOString() };
    cache.set(CACHE_KEY, resultado);
    return { ...resultado, deCache: false };
  } catch (err) {
    console.error("Error buscando info de paro en vivo:", err.message);
    return null;
  }
}
