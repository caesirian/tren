// src/propuestasEstado.js
// Propuestas de cambio de semáforo generadas SOLAS por el bot (a partir de
// cancelaciones/demoras del proxy, o de avisos de la fuente de verdad por
// texto/audio), pendientes de aprobación del admin. El bot NUNCA escribe el
// semáforo por su cuenta desde estos orígenes: solo guarda la propuesta y le
// manda a Coco los botones ✅ Tomar / 🚫 Ignorar. Reutiliza proponerEstado()
// (capturasApp.js) para no duplicar el mapeo de severidad/semáforo.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { proponerEstado } from "./capturasApp.js";

const COLECCION = "propuestasEstado";

let db = null;
function ensureInit() {
  if (db) return db;
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) return null;
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
    console.error("Error inicializando Firebase en propuestasEstado:", err.message);
    return null;
  }
}

// origen: "proxy_cancelacion" | "proxy_demora" | "aviso_fuente"
// alerta: { estado: "cancelado"|"demorado"|"interrumpido"|"normal"|"normalizado", texto, lugar? }
// Devuelve { id, propuesta } o null si no hay nada que proponer (ver
// proponerEstado: solo estados con severidad reconocida generan propuesta).
export async function crearPropuesta({ origen, detalle, alerta }) {
  const propuesta = proponerEstado({ alertas: [{ tipo: "operativa", estado: alerta.estado, texto: alerta.texto, lugar: alerta.lugar || null, truncado: false }] });
  if (!propuesta) return null;
  const registro = { origen, detalle: detalle || null, propuesta, revision: null, creadoEn: new Date().toISOString() };
  const firestore = ensureInit();
  if (!firestore) {
    console.log("[propuestasEstado fallback, sin Firestore]", JSON.stringify(registro).slice(0, 400));
    return { id: null, propuesta };
  }
  const ref = await firestore.collection(COLECCION).add({ ...registro, creadoEnTs: FieldValue.serverTimestamp() });
  return { id: ref.id, propuesta };
}

export async function obtenerPropuesta(id) {
  const firestore = ensureInit();
  if (!firestore || !id) return null;
  const snap = await firestore.collection(COLECCION).doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function marcarRevision(id, revision) {
  const firestore = ensureInit();
  if (!firestore || !id) return;
  await firestore.collection(COLECCION).doc(id).update({ revision });
}

// Resuelve el botón que tocó el admin. `aplicarEstado` es la función que
// escribe el semáforo (actualizarEstadoServicio). Una propuesta ya revisada
// no se vuelve a aplicar (doble toque o botón viejo).
export async function revisarPropuesta({ id, accion, quien }, { aplicarEstado }) {
  const p = await obtenerPropuesta(id);
  if (!p) return { resultado: "no_encontrada" };
  if (p.revision) return { resultado: "ya_revisada", revision: p.revision };
  const en = new Date().toISOString();
  if (accion === "ignorar") {
    await marcarRevision(id, { accion: "ignorado", por: quien, en });
    return { resultado: "ignorada" };
  }
  await aplicarEstado({ estado: p.propuesta.estado, mensaje: p.propuesta.mensaje, editor: `Telegram (HG) · ${p.origen}` });
  await marcarRevision(id, { accion: "tomado", estado: p.propuesta.estado, mensaje: p.propuesta.mensaje ?? null, por: quien, en });
  return { resultado: "tomada", propuesta: p.propuesta };
}
