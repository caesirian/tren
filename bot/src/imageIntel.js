// src/imageIntel.js
// Lee imágenes de comunicados oficiales (fotos que suben colaboradores) con
// Gemini Vision, extrae los datos clave (fecha, horario, tipo, resumen) y
// los guarda en Firestore para sumarlos a la "fuente de la verdad" del bot.
//
// Piloto: por ahora solo se activa para quienes estén en esAdminEstado()
// (ver index.js) — cuando sumen colaboradores, alcanza con agregarlos a la
// variable de entorno ESTADO_ADMIN_IDS, no hace falta tocar código acá.

import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Detección de comunicados repetidos
// ---------------------------------------------------------------------------
// Vivi (u otros) pueden subir la misma imagen más de una vez, o el mismo
// comunicado en otra captura. Antes de guardar/avisar se chequea:
//  1) misma imagen: hash SHA-256 de los bytes o file_unique_id de Telegram
//     (se chequea ANTES de llamar a Gemini, así ni gasta cuota);
//  2) mismo contenido: misma fecha (normalizada) y texto/resumen muy parecido
//     a un comunicado ya guardado en los últimos 14 días.

const VENTANA_DUPLICADOS_DIAS = 14;
let recientesEnMemoria = []; // respaldo sin Firestore y para carreras entre subidas

export function hashImagen(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

function sinAcentos(t) {
  return (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// "Domingo 27/09", "27 de septiembre", "27-9" -> "27/9". Sin fecha -> null.
export function claveFecha(fecha) {
  const t = sinAcentos(fecha);
  let m = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/.exec(t);
  if (m) return `${Number(m[1])}/${Number(m[2])}`;
  m = /(\d{1,2})\s*(?:de\s+)?([a-z]+)/.exec(t);
  if (m && MESES[m[2]]) return `${Number(m[1])}/${MESES[m[2]]}`;
  return t.trim() || null;
}

function palabras(t) {
  return new Set(sinAcentos(t).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
}

export function similitud(a, b) {
  const A = palabras(a);
  const B = palabras(b);
  if (!A.size || !B.size) return 0;
  let comunes = 0;
  for (const w of A) if (B.has(w)) comunes++;
  return comunes / (A.size + B.size - comunes); // Jaccard
}

async function comunicadosParaDuplicados() {
  const desde = new Date(Date.now() - VENTANA_DUPLICADOS_DIAS * 24 * 60 * 60 * 1000).toISOString();
  recientesEnMemoria = recientesEnMemoria.filter((c) => c.timestamp >= desde);
  let lista = [...recientesEnMemoria];
  const firestore = ensureInit();
  if (firestore) {
    try {
      const snap = await firestore.collection("comunicados").where("timestamp", ">=", desde).get();
      lista = lista.concat(snap.docs.map((d) => d.data()));
    } catch (err) {
      console.error("Error trayendo comunicados para detectar duplicados:", err.message);
    }
  }
  return lista;
}

// Para imágenes descartadas como no relevantes: se recuerdan solo en memoria
// para no reprocesarlas ni volver a avisar si las suben de nuevo.
export function registrarImagenDescartada({ imagenHash, fileUniqueId }) {
  recientesEnMemoria.push({ imagenHash, fileUniqueId, esComunicadoRelevante: false, timestamp: new Date().toISOString() });
}

// Paso 1 (antes de Gemini): ¿esta misma imagen ya se procesó?
export async function esImagenYaProcesada({ imagenHash, fileUniqueId }) {
  const lista = await comunicadosParaDuplicados();
  return lista.some((c) => (imagenHash && c.imagenHash === imagenHash) || (fileUniqueId && c.fileUniqueId === fileUniqueId));
}

// Paso 2 (después de Gemini): ¿otro comunicado ya guardado dice lo mismo?
// Devuelve el comunicado existente o null.
export async function buscarComunicadoDuplicado(datos) {
  const lista = await comunicadosParaDuplicados();
  const fechaNueva = claveFecha(datos.fecha);
  return (
    lista.find((c) => {
      if (!c.esComunicadoRelevante) return false;
      if (claveFecha(c.fecha) !== fechaNueva) return false; // otra fecha = otro comunicado
      const sim = Math.max(similitud(datos.resumen, c.resumen), similitud(datos.textoDetectado, c.textoDetectado));
      return sim >= (fechaNueva ? 0.5 : 0.7);
    }) || null
  );
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
    imagenHash: meta.imagenHash ?? null,
    fileUniqueId: meta.fileUniqueId ?? null,
    timestamp: new Date().toISOString(),
  };
  recientesEnMemoria.push(registro);

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

// Todos los comunicados guardados en la ventana pedida, SIN filtrar por
// esComunicadoRelevante — para poder revisar qué se guardó de verdad,
// incluyendo los que Gemini descartó como no relevantes.
export async function listarComunicados(horas = 72) {
  const firestore = ensureInit();
  if (!firestore) return null; // null = sin Firestore, distinto de [] = sin resultados
  try {
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
    const snap = await firestore.collection("comunicados").where("timestamp", ">=", desde).get();
    return snap.docs.map((d) => d.data()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (err) {
    console.error("Error listando comunicados:", err.message);
    return null;
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
