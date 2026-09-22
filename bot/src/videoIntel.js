// src/videoIntel.js
// Describe un video con Gemini (visión), para avisar al admin qué se ve sin
// tener que reenviar el archivo. Devuelve texto, o null si no hay nada que
// describir (video vacío/negro/ilegible) o Gemini no lo pudo procesar.

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash-lite";

export async function describirVideo(base64Data, mimeType = "video/mp4") {
  const prompt =
    "Describí en 2-3 oraciones, en español rioplatense, qué se ve y se escucha en este video (es de un grupo de pasajeros del Tren Sarmiento, Buenos Aires: puede ser una estación, una formación, gente hablando de algún incidente, o algo sin relación). " +
    "Si hay voz, incluí lo esencial de lo que dice. Si el video no se puede interpretar (pantalla negra, corrupto, etc.), respondé exactamente: SIN_CONTENIDO";
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Data } }] }],
  });
  const texto = response.text.trim();
  return !texto || texto === "SIN_CONTENIDO" ? null : texto;
}
