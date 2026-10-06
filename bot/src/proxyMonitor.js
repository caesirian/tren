// src/proxyMonitor.js
// Monitoreo automático del proxy de la app de Trenes Argentinos (ariedro),
// declarado FUENTE DE VERDAD por el admin (22/9). Dos funciones:
//
//  1) chequearCancelacionesProxy(): la llama el cron existente (/internal/check,
//     cada 10-15 min). Hace el barrido de Sarmiento y, si aparece una
//     cancelación NUEVA (no notificada antes), avisa al admin por privado.
//     Las demoras/leyendas no generan aviso propio (se ven en /apptrenes
//     scan); solo las cancelaciones, que es lo que pidió.
//     TODAVÍA no publica nada en el grupo (a pedido explícito, por ahora).
//
//  2) contextoProxyParaBot(): texto para el contexto de Gemini, con las
//     cancelaciones y leyendas QUE EL PROXY MUESTRA AHORA MISMO. Se usa para
//     responder preguntas en el grupo, con la misma prioridad que los avisos
//     de la fuente de verdad por texto (avisosFuente.js). Es "en vivo": no
//     depende de guardar/vencer nada, se arma con cada pregunta a partir del
//     barrido (cacheado 2 min).
//
// Interruptor: APP_TRENES_MONITOR_ACTIVO=false apaga las dos cosas.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { detectarTramoProxy, barridoEstructurado, datosServicio, textoCancelacion, trenesConOrigenInusual, hora, recorridoVivo, textoRecorrido } from "./appTrenes.js";
import { clasificarServicio, textoClasificacionPrivada, textoGrupoLocal } from "./locales.js";
import { getTramoLimitado, setTramoLimitado, limpiarTramoLimitado } from "./servicioLimitado.js";
import { contextoSalidasParaBot } from "./vigiaSalidas.js";

const COLECCION = "cancelacionesProxyVistas";
const COLECCION_DEMORAS = "demorasProxyAvisadas";
const UMBRAL_DEMORA_MIN = 10; // mismo umbral que "anormal" en el resto del bot
const COLECCION_ORIGEN = "origenesInusualesVistos";
// Demoras en el GRUPO: un solo resumen con las demoras ACTIVAS como máximo una
// vez cada 60 min (el aviso privado al admin sigue siendo por tren nuevo).
// Cuando preguntan por el servicio, el bot igual puede mencionar las demoras
// vigentes (ver contextoProxyParaBot).
const INTERVALO_AVISO_DEMORAS_MS = 60 * 60 * 1000;
const MAX_DEMORAS_EN_AVISO_GRUPO = 6;
const COLECCION_CONTROL_AVISOS = "controlAvisosGrupo";
let ultimoAvisoDemorasMs = 0;
const COLECCION_LOCALES = "localesFueraCronogramaVistos";
const RETENCION_DIAS = 3;

// Avisos de locales en el GRUPO (a pedido de Coco, 29/9): activo por defecto.
// Incluye (1) la aclaración "es un local" en las cancelaciones/demoras y (2) el
// aviso corto de una formación vacía que sale de una estación sin ser un local
// programado. Se apaga con LOCALES_AVISO_GRUPO=false.
export function avisoGrupoLocalesActivo() {
  return String(process.env.LOCALES_AVISO_GRUPO ?? "true").trim().toLowerCase() !== "false";
}
function etiquetaGrupoLocal(item) {
  if (!avisoGrupoLocalesActivo()) return "";
  const c = clasificarServicio(item);
  return c.esLocal ? ` 🚉 Es un local (sale de ${c.origen}${c.destino && c.destino !== "?" ? ` hacia ${c.destino}` : ""}).` : "";
}

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
    console.error("Error inicializando Firebase en proxyMonitor:", err.message);
    return null;
  }
}

export function monitorProxyActivo() {
  return String(process.env.APP_TRENES_MONITOR_ACTIVO ?? "true").trim().toLowerCase() !== "false";
}

let vistosEnMemoria = new Set(); // respaldo sin Firestore y para no repetir dentro del mismo proceso

// Clave estable para una cancelación puntual: mismo tren + misma estación +
// mismo día programado. Si la misma cancelación sigue apareciendo, no vuelve
// a avisar; si el tren de mañana con el mismo número se cancela, sí avisa.
function claveCancelacion(item) {
  const { est, s, prog } = datosServicio(item);
  const dia = prog ? new Date(prog).toISOString().slice(0, 10) : "s-fecha";
  return `${s.numero ?? "s-num"}-${est.id}-${dia}`;
}

async function yaVista(clave) {
  if (vistosEnMemoria.has(clave)) return true;
  const firestore = ensureInit();
  if (!firestore) return false;
  try {
    const doc = await firestore.collection(COLECCION).doc(clave).get();
    return doc.exists;
  } catch (err) {
    console.error("Error chequeando cancelación vista:", err.message);
    return false;
  }
}

async function marcarVista(clave) {
  vistosEnMemoria.add(clave);
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    await firestore.collection(COLECCION).doc(clave).set({ timestamp: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error("Error guardando cancelación vista:", err.message);
  }
}

// Housekeeping liviano: borra marcas de más de RETENCION_DIAS para no acumular
// para siempre. Se llama una vez por chequeo; si falla no corta el flujo.
async function limpiarVistasViejas() {
  const firestore = ensureInit();
  if (!firestore) return;
  try {
    const corte = new Date(Date.now() - RETENCION_DIAS * 24 * 60 * 60 * 1000);
    const snap = await firestore.collection(COLECCION).where("timestamp", "<", corte).limit(200).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  } catch (err) {
    console.error("Error limpiando cancelaciones vistas viejas:", err.message);
  }
}

function lineaCancelacion(item) {
  const { est, s, prog, destino } = datosServicio(item);
  const base = `• #${s.numero ?? "?"} ${est.nombre} → ${destino} · prog ${hora(prog)}\n   ❌ ${textoCancelacion(s.cancelacion)}`;
  const extra = textoClasificacionPrivada(clasificarServicio(item));
  return extra ? `${base}\n${extra}` : base;
}

// Para el cron: detecta cancelaciones nuevas y arma el texto para avisar al
// admin. Devuelve { nuevas: [...], texto: string|null, erroresProxy: [...] }.
// Trenes que declaran salir de una estación distinta a la habitual (ej. los
// "locales" que oficialmente arrancan en Flores, saliendo de Liniers). Sirve
// para anticiparse: el dato suele aparecer con el tren en "Programado", antes
// de que realmente salga, así que avisar apenas se detecta da margen.
export async function chequearOrigenesInusuales() {
  if (!monitorProxyActivo()) return { nuevos: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado(); // comparte caché con el resto de los chequeos
  } catch (err) {
    console.error("Error consultando el proxy para orígenes inusuales:", err.message);
    return { nuevos: [], texto: null, error: err.message };
  }

  const candidatos = trenesConOrigenInusual(barrido.todos);
  const nuevos = [];
  for (const item of candidatos) {
    const d = datosServicio(item);
    const dia = d.prog ? new Date(d.prog).toISOString().slice(0, 10) : "s-fecha";
    const clave = `${d.s.numero ?? "s-num"}-${d.origenReal}-${dia}`;
    const firestore = ensureInit();
    let visto = vistosEnMemoria.has(clave);
    if (!visto && firestore) {
      try {
        visto = (await firestore.collection(COLECCION_ORIGEN).doc(clave).get()).exists;
      } catch (err) {
        console.error("Error chequeando origen inusual visto:", err.message);
      }
    }
    if (visto) continue;
    vistosEnMemoria.add(clave);
    if (firestore) firestore.collection(COLECCION_ORIGEN).doc(clave).set({ timestamp: FieldValue.serverTimestamp() }).catch((err) => console.error("Error guardando origen inusual:", err.message));
    nuevos.push(item);
  }
  // Resumen para el grupo: todas las demoras activas, a lo sumo 1 vez por hora.
  const textosGrupo = await resumenDemorasParaGrupo(demorados);

  if (!nuevos.length) return { nuevos: [], texto: null, textosGrupo };
  const texto =
    `⏰ La app de Trenes Argentinos informa ${nuevos.length} tren(es) con demora nueva de 10+ min:\n\n` +
    nuevos
      .map((item) => {
        const d = datosServicio(item);
        const base = `• #${d.s.numero ?? "?"} → ${d.destino} | ${d.est.nombre}: prog ${hora(d.prog)} / est ${hora(d.estim)} (+${d.demora} min)`;
        const extra = textoClasificacionPrivada(clasificarServicio(item));
        return extra ? `${base}\n${extra}` : base;
      })
      .join("\n") +
    `\n\n(Detectado por el proxy no oficial. Al grupo se le informan las demoras activas como máximo una vez por hora.)`;
  return { nuevos, texto, textosGrupo };
}

// Un único mensaje para el grupo con las demoras activas ahora, como máximo una
// vez cada 60 min. La marca de la última publicación se guarda también en
// Firestore para que un reinicio de Render no la pierda. Texto plano
// (publicarEnGrupo no usa parse_mode).
async function resumenDemorasParaGrupo(demorados) {
  if (!demorados.length) return [];
  const ahora = Date.now();
  if (ahora - ultimoAvisoDemorasMs < INTERVALO_AVISO_DEMORAS_MS) return [];
  ultimoAvisoDemorasMs = ahora; // se marca ya, para que dos chequeos simultáneos no publiquen ambos

  const firestore = ensureInit();
  if (firestore) {
    try {
      const snap = await firestore.collection(COLECCION_CONTROL_AVISOS).doc("demoras").get();
      const ultimo = Number(snap.data()?.ultimoEnvioMs) || 0;
      if (ahora - ultimo < INTERVALO_AVISO_DEMORAS_MS) {
        ultimoAvisoDemorasMs = ultimo;
        return [];
      }
    } catch (err) {
      console.error("Error leyendo la marca del último aviso de demoras:", err.message);
    }
    firestore
      .collection(COLECCION_CONTROL_AVISOS)
      .doc("demoras")
      .set({ ultimoEnvioMs: ahora, actualizado: FieldValue.serverTimestamp() }, { merge: true })
      .catch((err) => console.error("Error guardando la marca del último aviso de demoras:", err.message));
  }

  const ordenados = [...demorados].sort((a, b) => (datosServicio(b).demora ?? 0) - (datosServicio(a).demora ?? 0));
  const mostrados = ordenados.slice(0, MAX_DEMORAS_EN_AVISO_GRUPO);
  const bloques = mostrados.map((item) => {
    const d = datosServicio(item);
    return `🚆 #${d.s.numero ?? "?"} · sentido ${d.destino}\n📍 ${d.est.nombre}: ${hora(d.prog)} → ${hora(d.estim)} (+${d.demora} min)${etiquetaGrupoLocal(item)}`;
  });
  const resto = ordenados.length - mostrados.length;
  return [
    `⏰ ${mostrados.length === 1 ? "Demora activa en el Sarmiento" : "Demoras activas en el Sarmiento"}\n\n` +
      bloques.join("\n\n") +
      (resto > 0 ? `\n\n…y ${resto} más.` : "") +
      `\n\nHorarios estimados, pueden variar.`,
  ];
}

export async function chequearCancelacionesProxy() {
  if (!monitorProxyActivo()) return { nuevas: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado({ forzar: true });
  } catch (err) {
    console.error("Error consultando el proxy de la app para cancelaciones:", err.message);
    return { nuevas: [], texto: null, error: err.message };
  }

  const canceladas = barrido.todos.filter((item) => item.r?.servicio?.cancelacion);
  const nuevas = [];
  for (const item of canceladas) {
    const clave = claveCancelacion(item);
    if (await yaVista(clave)) continue;
    await marcarVista(clave);
    nuevas.push(item);
  }
  limpiarVistasViejas().catch(() => {});

  if (!nuevas.length) return { nuevas: [], texto: null };
  const texto =
    `🚨 La app de Trenes Argentinos informa ${nuevas.length} cancelación(es) nueva(s) de Sarmiento:\n\n` +
    nuevas.map(lineaCancelacion).join("\n") +
    `\n\n(Detectado por el proxy no oficial. Se publicó en el grupo.)`;
  // Un solo mensaje para el grupo, aunque haya varias cancelaciones nuevas en el mismo chequeo.
  const bloquesCan = nuevas.map((item) => {
    const d = datosServicio(item);
    return `🚆 #${d.s.numero ?? "?"} · sentido ${d.destino}\n📍 ${d.est.nombre}: programado ${hora(d.prog)}\n❌ ${textoCancelacion(d.s.cancelacion)}${etiquetaGrupoLocal(item)}`;
  });
  const textosGrupo = [
    `🚨 ${nuevas.length === 1 ? "Tren cancelado en el Sarmiento" : "Trenes cancelados en el Sarmiento"}\n\n` + bloquesCan.join("\n\n"),
  ];
  return { nuevas, texto, textosGrupo };
}

// Locales confirmados por el proxy que están FUERA DE CRONOGRAMA (no figuran en
// el cronograma, salen de otra estación o con otro horario). Aviso solo privado.
// Una vez por tren/origen/día.
export async function chequearLocalesFueraCronograma() {
  if (!monitorProxyActivo()) return { nuevos: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado(); // comparte caché con el resto de los chequeos
  } catch (err) {
    console.error("Error consultando el proxy para locales fuera de cronograma:", err.message);
    return { nuevos: [], texto: null, error: err.message };
  }

  // Se prefiere el ítem visto en la propia estación de origen: da la hora de salida real.
  const candidatos = barrido.todos
    .map((item) => ({ item, c: clasificarServicio(item) }))
    .filter((x) => x.c.fueraDeCronograma)
    .sort((a, b) => Number(b.c.enOrigen) - Number(a.c.enOrigen));

  const nuevos = [];
  for (const { item, c } of candidatos) {
    const d = datosServicio(item);
    const dia = d.prog ? new Date(d.prog).toISOString().slice(0, 10) : "s-fecha";
    const horaProg = c.numero == null && d.prog ? `-${hora(d.prog).replace(/[^0-9]/g, "")}` : "";
    const clave = `${c.numero ?? "s-num"}-${String(c.origen).replace(/[^a-zA-Z0-9]/g, "")}${horaProg}-${dia}`;
    if (vistosEnMemoria.has(`local:${clave}`)) continue;
    const firestore = ensureInit();
    let visto = false;
    if (firestore) {
      try {
        visto = (await firestore.collection(COLECCION_LOCALES).doc(clave).get()).exists;
      } catch (err) {
        console.error("Error chequeando local fuera de cronograma visto:", err.message);
      }
    }
    vistosEnMemoria.add(`local:${clave}`);
    if (visto) continue;
    if (firestore) firestore.collection(COLECCION_LOCALES).doc(clave).set({ timestamp: FieldValue.serverTimestamp() }).catch((err) => console.error("Error guardando local fuera de cronograma:", err.message));
    nuevos.push({ item, c });
  }
  if (!nuevos.length) return { nuevos: [], texto: null };

  const texto =
    `🚉⚠️ ${nuevos.length} local(es) confirmado(s) por el proxy fuera de cronograma:\n\n` +
    nuevos
      .map(({ item, c }) => {
        const d = datosServicio(item);
        return `• #${c.numero ?? "?"} ${c.etiqueta} · prog ${hora(d.prog)} (${d.est.nombre})\n   ${c.motivos.join("; ")}`;
      })
      .join("\n") +
    `\n\n(Detalle solo privado; al grupo va una línea corta. Cotejo contra el cronograma base del 9/3/2026; en feriados puede dar falsos positivos.)`;
  // Aviso corto para el grupo: locales no programados y locales reprogramados, una
  // línea cada uno. Si en un mismo chequeo aparecen muchos (feriado o cambio de
  // cronograma: el cronograma base no distingue feriados), no se inunda el grupo:
  // se avisa solo por privado.
  const MAX_AVISOS_GRUPO_POR_CHEQUEO = 3;
  let textosGrupo = avisoGrupoLocalesActivo() ? [...new Set(nuevos.map((n) => textoGrupoLocal(n.c)).filter(Boolean))] : [];
  let texto2 = texto;
  if (textosGrupo.length > MAX_AVISOS_GRUPO_POR_CHEQUEO) {
    texto2 += `\n\n⚠️ Son ${textosGrupo.length} avisos de una sola vez (posible feriado o cambio de cronograma): NO los publiqué en el grupo.`;
    textosGrupo = [];
  }
  return { nuevos: nuevos.map((n) => n.item), texto: texto2, textosGrupo };
}

// Para el contexto del bot al responder preguntas: cancelaciones y leyendas
// que el proxy muestra AHORA. Declarado fuente de verdad por el admin, así
// que se redacta con la misma prioridad que AVISOS VIGENTES DE LA FUENTE DE
// VERDAD. Devuelve null si no hay nada relevante o el monitor está apagado.
export async function contextoProxyParaBot() {
  if (!monitorProxyActivo()) return null;
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error("Error consultando el proxy de la app para el contexto:", err.message);
    return null;
  }

  // Recorrido acortado (servicio limitado): esto manda por sobre cualquier
  // horario fijo del cronograma — si hoy los trenes no llegan a Moreno (o no
  // arrancan desde ahí), el bot NUNCA debe decir que sí llegan/salen.
  let bloqueRecorrido = null;
  try {
    const recorrido = await recorridoVivo();
    const texto = textoRecorrido(recorrido);
    if (texto) {
      bloqueRecorrido = `\n== RECORRIDO REAL DE HOY (declarado fuente de verdad; en vivo) ==\n${texto}\nEsto pisa a cualquier horario fijo del cronograma: si una estación queda fuera del alcance indicado arriba en un sentido, ese sentido NO tiene servicio hoy en esa estación — no inventes que sí llega, y no menciones cómo se calculó este dato.`;
    }
  } catch (err) {
    console.error("Error calculando el recorrido real para el contexto:", err.message);
  }

  // Formaciones en Once/Moreno: si ya salió, si está esperando en la estación (vigiaSalidas.js).
  const bloqueFormaciones = contextoSalidasParaBot();

  // Cancelaciones y leyendas primero; después los trenes con demora de 10+ min
  // (así, si preguntan por el servicio, el bot puede mencionar las demoras vigentes).
  const conAviso = barrido.todos.filter((item) => item.r?.servicio?.cancelacion || item.r?.servicio?.leyenda);
  const demoradosAhora = barrido.todos
    .filter((item) => {
      if (conAviso.includes(item)) return false;
      const d = datosServicio(item);
      return d.demora != null && d.demora >= UMBRAL_DEMORA_MIN;
    })
    .sort((a, b) => (datosServicio(b).demora ?? 0) - (datosServicio(a).demora ?? 0));
  const relevantes = [...conAviso, ...demoradosAhora];
  if (!relevantes.length) return [bloqueRecorrido, bloqueFormaciones].filter(Boolean).join("\n") || null;

  const lineas = relevantes.slice(0, 12).map((item) => {
    const { est, s, prog, estim, demora, destino, estado } = datosServicio(item);
    let l = `- #${s.numero ?? "?"} ${est.nombre} → ${destino} · prog ${hora(prog)}${estim ? ` / est ${hora(estim)}${demora != null ? ` (${demora >= 0 ? "+" : ""}${demora} min)` : ""}` : ""} · ${estado}`;
    if (s.cancelacion) l += `\n  ❌ Cancelado: ${textoCancelacion(s.cancelacion)}`;
    if (s.leyenda) l += `\n  📢 ${s.leyenda}`;
    return l;
  });

  const bloqueCancelaciones =
    `\n== ESTADO EN VIVO — APP TRENES ARGENTINOS (declarada fuente de verdad; consultado ahora mismo) ==\n` +
    lineas.join("\n") +
    `\nEsto es lo que se detecta EN ESTE MOMENTO (no vencido, no hay que calcular vigencia): tiene la misma prioridad que los avisos de la fuente de verdad por texto. Nunca menciones cómo se obtuvo este dato ni nombres de sistemas o mecanismos internos. Si preguntan por el estado del servicio, mencioná también los trenes con demora de 10+ min que aparezcan acá (con su estación y los minutos). Un tren específico cancelado no implica que todo el ramal esté cortado; hablá solo del/de los tren(es) que aparecen acá salvo que haya varios en el mismo tramo y horario.`;

  return [bloqueRecorrido, bloqueFormaciones, bloqueCancelaciones].filter(Boolean).join("\n");
}

// Servicio limitado detectado por el proxy (recorte en Once o en Moreno).
// Para no activarlo por un dato suelto (o a la noche, con pocos trenes), tiene
// que verse en 2 chequeos seguidos; se renueva mientras siga viéndose y se
// apaga solo cuando vuelve el recorrido completo. No pisa uno cargado a mano
// ni por la fuente de verdad. Solo avisa al admin por privado.
// Interruptor: TRAMO_LIMITADO_AUTO=false.
let deteccionesSeguidas = 0;
export async function chequearTramoLimitadoProxy() {
  if (!monitorProxyActivo() || String(process.env.TRAMO_LIMITADO_AUTO ?? "true").trim().toLowerCase() === "false") return { texto: null, desactivado: true };
  let det;
  try {
    det = await detectarTramoProxy();
  } catch (err) {
    console.error("Error detectando servicio limitado desde el proxy:", err.message);
    return { texto: null, error: err.message };
  }
  const actual = await getTramoLimitado();

  if (!det) {
    deteccionesSeguidas = 0;
    if (actual?.origen === "proxy") {
      await limpiarTramoLimitado();
      return { texto: "✅ El proxy volvió a mostrar el recorrido completo Once–Moreno: di de baja el servicio limitado que había detectado solo." };
    }
    return { texto: null };
  }

  deteccionesSeguidas += 1;
  if (deteccionesSeguidas < 2) return { texto: null };
  if (actual && actual.origen !== "proxy") return { texto: null }; // manda el manual / la fuente de verdad

  const yaActivo = actual?.origen === "proxy" && actual.desdeIdx === det.desdeIdx && actual.hastaIdx === det.hastaIdx;
  const tramo = await setTramoLimitado({
    estA: det.desdeIdx,
    estB: det.hastaIdx,
    motivo: "detectado por los trenes que figuran hoy en el sistema",
    duracionMin: 15,
    origen: "proxy",
  });
  if (!tramo || yaActivo) return { texto: null };
  return {
    texto:
      `🚧 Detecté servicio limitado por el proxy: los trenes de hoy solo circulan entre ${tramo.desde} y ${tramo.hasta} (${det.trenes} trenes vistos). ` +
      `Ya lo estoy aplicando en el bot y en el tablero. Si es un falso positivo: /limitado off (no vuelve a activarse solo por 1 hora). Si querés fijarlo con otro tramo o duración: /limitado <estación> <estación> [minutos] [motivo].`,
  };
}
