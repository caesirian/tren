// src/firestoreStatus.js
// Lee el estado en vivo del servicio ("semáforo") desde el mismo Firestore
// que usa trensarmientoenlinea.com.ar (mod.html), así el bot y la web
// muestran exactamente lo mismo.
//
// Colección/documento reales (confirmados contra mod.html): estadoServicio/actual
// Proyecto de Firebase: tren-sarmiento-en-linea
//
// Requiere las credenciales de un service account de Firebase (variables
// de entorno FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).
// Si no se configuran, el bot sigue funcionando solo con datos fijos.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { similitud } from "./imageIntel.js";

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
          // Render guarda saltos de línea como \n literal en la variable de entorno
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    db = getFirestore();
    return db;
  } catch (err) {
    console.error("Error inicializando Firebase (revisar FIREBASE_PRIVATE_KEY):", err.message);
    return null;
  }
}

// Acceso compartido a Firestore para otros módulos (semáforo automático).
export const firestoreDb = () => ensureInit();

const ETIQUETAS_ESTADO = {
  normal: "Servicio normal",
  modificado: "Servicio con demoras",
  paro: "Servicio interrumpido",
};

// Umbral de similitud para considerar que un texto nuevo es "el mismo aviso"
// que uno ya activo (0..1, ver similitud() en imageIntel.js). arrayUnion por
// sí solo solo evita el string EXACTO repetido — si Gemini redacta el mismo
// comunicado con otras palabras cada vez que se sube una foto, arrayUnion no
// lo detecta y el aviso termina apareciendo varias veces en el sitio.
const UMBRAL_SIMILITUD_ALERTA = 0.55;

// Suma un texto al array "alertas" del documento — el sitio ya lo muestra
// independiente del color del semáforo (pensado justo para avisos tipo
// "obra programada" con servicio aún normal). NO toca estado ni mensaje,
// es un complemento, no un reemplazo. Antes de sumar, chequea si ya hay un
// aviso activo parecido (por similitud de texto, no solo string exacto) y
// si lo hay, no vuelve a grabarlo. Devuelve { agregado: boolean, similar? }.
export async function agregarAlertaComplementaria(texto) {
  const firestore = ensureInit();
  if (!firestore) throw new Error("Firestore no está configurado (faltan credenciales).");
  const ref = firestore.collection("estadoServicio").doc("actual");
  const snap = await ref.get();
  const actuales = Array.isArray(snap.data()?.alertas) ? snap.data().alertas : [];
  const parecido = actuales.find((a) => similitud(a, texto) >= UMBRAL_SIMILITUD_ALERTA);
  if (parecido) return { agregado: false, similar: parecido };
  await ref.set({ alertas: FieldValue.arrayUnion(texto) }, { merge: true });
  return { agregado: true };
}

export async function listarAlertasComplementarias() {
  const firestore = ensureInit();
  if (!firestore) throw new Error("Firestore no está configurado (faltan credenciales).");
  const snap = await firestore.collection("estadoServicio").doc("actual").get();
  return Array.isArray(snap.data()?.alertas) ? snap.data().alertas : [];
}

// indice es 0-based, tal como lo devuelve listarAlertasComplementarias().
export async function quitarAlertaComplementaria(indice) {
  const actuales = await listarAlertasComplementarias();
  if (indice < 0 || indice >= actuales.length) throw new Error(`No hay una alerta en la posición ${indice + 1} (hay ${actuales.length}).`);
  const restantes = actuales.filter((_, i) => i !== indice);
  const firestore = ensureInit();
  await firestore.collection("estadoServicio").doc("actual").set({ alertas: restantes }, { merge: true });
  return actuales[indice];
}

export async function limpiarAlertasComplementarias() {
  const firestore = ensureInit();
  if (!firestore) throw new Error("Firestore no está configurado (faltan credenciales).");
  await firestore.collection("estadoServicio").doc("actual").set({ alertas: [] }, { merge: true });
}

export async function actualizarEstadoServicio({ estado, mensaje, editor }) {
  const firestore = ensureInit();
  if (!firestore) throw new Error("Firestore no está configurado (faltan credenciales).");

  const datos = {
    estado,
    actualizado: new Date().toISOString(),
    editor,
  };
  // "normal" limpia el mensaje de alerta; demoras/paro sí lo necesitan.
  if (mensaje) datos.mensaje = mensaje;
  else if (estado === "normal") datos.mensaje = "Sin alertas activas.";

  // merge:true a propósito — el panel de Admin usa setDoc sin merge y
  // pisa todo el documento; acá lo evitamos para no borrar mostrarTitulares
  // ni otros campos que no tocamos desde el bot.
  await firestore.collection("estadoServicio").doc("actual").set(datos, { merge: true });
}

export async function getEstadoServicio() {
  const firestore = ensureInit();
  if (!firestore) return null;

  try {
    const snap = await firestore.collection("estadoServicio").doc("actual").get();
    if (!snap.exists) return null;
    const d = snap.data();

    return {
      estado: d.estado || "normal",
      etiqueta: ETIQUETAS_ESTADO[d.estado] || "Servicio normal",
      mensaje: d.mensaje || "Sin alertas activas.",
      alertas: Array.isArray(d.alertas) ? d.alertas : [],
      ultimaActualizacion: d.ultimaActualizacion || null,
      actualizado: d.actualizado || null,
      editor: d.editor || null,
      vigencia: d.vigencia || null,
      mostrarTitulares: d.mostrarTitulares === true,
    };
  } catch (err) {
    console.error("Error leyendo estado de Firestore:", err.message);
    return null;
  }
}
