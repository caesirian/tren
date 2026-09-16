// src/imageIntel.js
// Lee imágenes de comunicados oficiales (fotos que suben colaboradores) con
// Gemini Vision, extrae los datos clave (fecha, horario, tipo, resumen) y
// los guarda en Firestore para sumarlos a la "fuente de la verdad" del bot.
//
// Piloto: por ahora solo se activa para quienes estén en esAdminEstado()
// (ver index.js) — cuando sumen colaboradores, alcanza con agregarlos a la
// variable de entorno ESTADO_ADMIN_IDS, no hace falta tocar código acá.

import { GoogleGenAI } from "@google/genai";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash-lite";

let db = null;
function ensureInit() {
  if (db) return db;
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    return null;
  }
  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    db = getFirestore();
    return db;
  } catch (err) {
    console.error("Error inicializando Firebase en imageIntel:", err.message);
    return null;
  }
}

const PROMPT_EXTRACCION = `
Esta imagen es (probablemente) una comunicación oficial sobre el servicio
del Tren Sarmiento u otro transporte del AMBA (puede ser un cartel, una
captura de un tuit/comunicado, un aviso de estación, etc.).

Leé el texto de la imagen y devolvé SOLO un JSON (sin markdown, sin
backticks, sin texto extra) con esta forma exacta:

{
  "esComunicadoRelevante": true o false,
  "tipo": "paro" | "demora" | "normalizacion" | "obra" | "aviso general" | "otro",
  "fecha": "la fecha que menciona el comunicado, tal como aparece, o null si no menciona ninguna",
  "horario": "el horario que menciona, tal como aparece, o null si no menciona ninguno",
  "resumen": "un resumen de 1-2 oraciones en español rioplatense de lo que dice",
  "textoDetectado": "el texto literal que pudiste leer en la imagen, lo más completo posible"
}

Si la imagen NO parece un comunicado de transporte (foto random, meme,
etc.), poné "esComunicadoRelevante": false y completá el resto con tu mejor
estimación de todos modos, sin inventar datos que no estén en la imagen.
`.trim();

function limpiarJSON(texto) {
  return texto.replace(/```json|```/g, "").trim();
}

export async function analizarComunicadoImagen(base64Data, mimeType = "image/jpeg") {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: PROMPT_EXTRACCION }, { inlineData: { mimeType, data: base64Data } }],
      },
    ],
  });

  const texto = limpiarJSON(response.text.trim());
  try {
    return JSON.parse(texto);
  } catch (err) {
    throw new Error("No pude interpretar la respuesta de Gemini como JSON: " + texto.slice(0, 200));
  }
}

export async function guardarComunicado(datos, meta) {
  const registro = {
    ...datos,
    cargadoPor: meta.quien,
    userId: meta.userId,
    timestamp: new Date().toISOString(),
  };

  const firestore = ensureInit();
  if (!firestore) {
    console.log("[comunicados fallback]", JSON.stringify(registro));
    return { id: null };
  }

  try {
    const ref = await firestore.collection("comunicados").add({
      ...registro,
      creadoEn: FieldValue.serverTimestamp(),
    });
    return { id: ref.id };
  } catch (err) {
    console.error("Error guardando comunicado:", err.message);
    return { id: null };
  }
}

// Comunicados recientes (48hs por defecto) para sumar al contexto del bot.
export async function comunicadosRecientes(horas = 48) {
  const firestore = ensureInit();
  if (!firestore) return [];
  try {
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
    const snap = await firestore.collection("comunicados").where("timestamp", ">=", desde).get();
    return snap.docs
      .map((d) => d.data())
      .filter((d) => d.esComunicadoRelevante)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (err) {
    console.error("Error trayendo comunicados recientes:", err.message);
    return [];
  }
}
