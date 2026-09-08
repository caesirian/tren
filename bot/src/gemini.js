// src/gemini.js
// Usa Gemini (capa gratuita de Google AI Studio) para responder en lenguaje
// natural, siempre basándose en el contexto que le pasamos (datos fijos +
// estado en vivo del semáforo). Así evitamos que "invente" horarios.

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const SYSTEM_INSTRUCTION = `
Sos el asistente del grupo de Telegram de la comunidad del Tren Sarmiento
(trensarmientoenlinea.com.ar). Respondé dudas sobre horarios, frecuencias,
tarifas, ramales y transporte público del AMBA en general (colectivos, subte,
combinaciones), en español rioplatense (voseo), tono cordial y directo,
como alguien del barrio que conoce el tren.

Reglas:
- Basate SOLO en el CONTEXTO que te paso a continuación. No inventes horarios
  exactos, tarifas exactas ni datos que no estén en el contexto.
- Si el contexto no alcanza para responder con precisión, decilo con
  honestidad y sugerí dónde confirmar (app Trenes Argentinos, @TrenSarmiento,
  o la web trensarmientoenlinea.com.ar).
- Sé breve: 2 a 5 líneas salvo que la pregunta pida más detalle.
- Si preguntan por el estado del servicio AHORA y hay datos de "estado en
  vivo" en el contexto, usalos como fuente principal por sobre las
  frecuencias orientativas.
`.trim();

export async function responderPregunta({ pregunta, contexto }) {
  const prompt = `${SYSTEM_INSTRUCTION}

=== CONTEXTO ===
${contexto}
=== FIN CONTEXTO ===

Pregunta del usuario del grupo: "${pregunta}"

Respuesta:`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}
