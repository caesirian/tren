// src/spamDetector.js
// Detecta spam / promociones en el grupo (canales de WhatsApp, invitaciones,
// ofertas, estafas, "seguime", etc.). Dos capas para no gastar Gemini en cada
// mensaje ni borrar mensajes legítimos:
//  A) Reglas duras (regex): patrones que en un grupo de pasajeros son spam
//     casi seguro (links de canales/grupos de WhatsApp, invitaciones de
//     Telegram, "seguí el canal ...").
//  B) Solo si el mensaje trae un link ajeno o palabras de promoción, lo
//     decide Gemini con criterio conservador. Si Gemini falla, NO se toma
//     como spam (mejor dejar pasar uno que borrar un mensaje legítimo).

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash-lite";

const REGLAS_DURAS = [
  { re: /whatsapp\.com\/(channel|catalog)|chat\.whatsapp\.com|wa\.me\//i, motivo: "link de canal, grupo o contacto de WhatsApp" },
  { re: /(t|telegram)\.me\/(\+|joinchat)/i, motivo: "invitación a grupo/canal de Telegram" },
  { re: /\b(segu[ií]|seguime|sigue|sumate a|unite a|suscrib[ií]te?|suscribite a)\b[^.\n]{0,40}\b(canal|grupo|p[aá]gina|perfil|cuenta)\b/i, motivo: "invitación a seguir un canal/grupo/perfil" },
];

const DOMINIOS_PERMITIDOS = [
  "trensarmientoenlinea.com.ar",
  "hgsolucionesweb.com.ar",
  "argentina.gob.ar",
  "trenesargentinos.gob.ar",
  "sube.gob.ar",
  "x.com/trensarmiento",
  "x.com/infotsarmiento",
  "twitter.com/trensarmiento",
  "twitter.com/infotsarmiento",
  "google.com/maps",
  "maps.app.goo.gl",
  "goo.gl/maps",
];

const RE_URL = /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9-]+\.(com|net|org|ar|io|me|ly|gl|shop|store|xyz|club|app|link|site|online)\b[^\s]*)/gi;
const RE_PALABRAS_PROMO = /\b(promo(ci[oó]n)?|sorteo|regalo|gratis|ganar|gan[aá]s?|dinero|plata f[aá]cil|inversi[oó]n|cripto|casino|apuestas?|forex|oferta|descuento|vendo|venta|mystery box|link en (bio|perfil)|escribime al privado|contactame|whatsapp)\b/i;

export function detectarSpamPorReglas(texto) {
  for (const { re, motivo } of REGLAS_DURAS) if (re.test(texto)) return { spam: true, motivo, capa: "reglas" };
  return { spam: false };
}

// ¿Vale la pena consultarle a Gemini? (link ajeno o palabras de promoción)
function esDudoso(texto) {
  const t = texto.toLowerCase();
  const urls = t.match(RE_URL) || [];
  const hayLinkAjeno = urls.some((u) => !DOMINIOS_PERMITIDOS.some((d) => u.includes(d)));
  return hayLinkAjeno || RE_PALABRAS_PROMO.test(t);
}

async function clasificarConGemini(texto) {
  const prompt = `
Sos moderador del grupo de Telegram de pasajeros del Tren Sarmiento (Buenos Aires). Decidí si este mensaje es SPAM o PROMOCIÓN no deseada: publicidad, venta, sorteos, canales o grupos para seguir, estafas, inversiones/cripto/apuestas, links promocionales sin relación con el tren.

NO es spam: preguntas o comentarios sobre el tren, horarios, tarifas, estaciones, demoras, paros, SUBE, quejas, charla normal, ni links a noticias o cuentas oficiales sobre transporte. Ante la duda, NO es spam.

Mensaje: """${texto.slice(0, 800)}"""

Respondé SOLO un JSON: {"esSpam": true o false, "motivo": "frase corta en español"}
`.trim();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  const json = JSON.parse(response.text.replace(/```json|```/g, "").trim());
  return { spam: json.esSpam === true, motivo: String(json.motivo || "promoción/spam").slice(0, 120), capa: "gemini" };
}

export async function evaluarSpam(texto) {
  const t = (texto || "").trim();
  if (t.length < 6) return { spam: false };
  const porReglas = detectarSpamPorReglas(t);
  if (porReglas.spam) return porReglas;
  if (!esDudoso(t)) return { spam: false };
  try {
    return await clasificarConGemini(t);
  } catch (err) {
    console.warn("spamDetector: Gemini falló, se deja pasar:", err.message);
    return { spam: false };
  }
}
