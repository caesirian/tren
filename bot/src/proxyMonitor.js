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

import { createHash } from "node:crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { detectarTramoProxy, barridoEstructurado, datosServicio, textoCancelacion, trenesConOrigenInusual, hora, recorridoVivo, textoRecorrido } from "./appTrenes.js";
import { clasificarServicio, textoClasificacionPrivada, textoGrupoLocal } from "./locales.js";
import { getTramoLimitado, setTramoLimitado, limpiarTramoLimitado } from "./servicioLimitado.js";
import { contextoSalidasParaBot } from "./vigiaSalidas.js";
import { crearEstadoDetenidos, detectarDetenidos, detectorDetenidosActivo } from "./trenDetenido.js";

const COLECCION = "cancelacionesProxyVistas";
const COLECCION_DEMORAS = "demorasProxyAvisadas";
const UMBRAL_DEMORA_MIN = 10; // mismo umbral que "anormal" en el resto del bot
// Una demora ya avisada vuelve a avisarse si EMPEORA: nivel 0 = 10–29 min, 1 = 30–49, 2 = 50–69…
// (ver chequearDemorasEscaladas). Así un tren que pasa de 10 a 60 min no queda en silencio.
const PASO_ESCALA_MIN = 20;
const nivelDemora = (min) => (min >= UMBRAL_DEMORA_MIN + PASO_ESCALA_MIN ? Math.floor((min - UMBRAL_DEMORA_MIN) / PASO_ESCALA_MIN) : 0);
const COLECCION_LEYENDAS = "leyendasProxyVistas";
const COLECCION_FUERA_TRAMO = "fueraTramoProxyVistos";
const COLECCION_ORIGEN = "origenesInusualesVistos";
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

// ── Diagnóstico por logs ──────────────────────────────────────────────────
// Los logs de Render solo mostraban contadores ("1 cancelación nueva"), sin
// decir qué tren, en qué estación ni qué leyenda traía el proxy. Estas dos
// funciones agregan ese detalle SIN cambiar ningún aviso ni decisión del bot.

// Una línea legible por servicio: número, estación, destino, horarios, demora, estado.
export function descripcionItemLog(item) {
  const { est, s, prog, estim, demora, destino, estado } = datosServicio(item);
  let l = `#${s.numero ?? "?"} ${est.nombre} → ${destino} · prog ${hora(prog)}${estim ? ` / est ${hora(estim)}` : ""}${demora != null ? ` (${demora >= 0 ? "+" : ""}${demora} min)` : ""} · ${estado}`;
  if (s.cancelacion) l += ` · CANCELADO: ${textoCancelacion(s.cancelacion)}`;
  if (s.leyenda) l += ` · LEYENDA: ${String(s.leyenda).replace(/\s+/g, " ").slice(0, 200)}`;
  return l;
}

// Loguea un detalle de lo que mostró el barrido del proxy. Solo escribe cuando
// algo cambió respecto del chequeo anterior (cancelados / demorados / leyendas /
// errores), más un latido cada 12 chequeos para saber que el barrido sigue
// llegando aunque no haya novedades. No hace consultas nuevas (usa el caché).
let firmaBarridoAnterior = null;
let chequeosDesdeUltimoLatido = 0;
export async function registrarResumenBarrido(origen = "cron") {
  if (!monitorProxyActivo()) return;
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error(`Resumen proxy (${origen}): error consultando el proxy — ${err.message}`);
    return;
  }
  const todos = barrido.todos || [];
  const cancelados = todos.filter((i) => i.r?.servicio?.cancelacion);
  const demorados = todos.filter((i) => {
    const d = datosServicio(i);
    return !d.s.cancelacion && d.demora != null && d.demora >= UMBRAL_DEMORA_MIN;
  });
  const conLeyenda = todos.filter((i) => i.r?.servicio?.leyenda);
  const errores = barrido.errores || [];
  const maxDemora = todos.reduce((m, i) => Math.max(m, datosServicio(i).demora ?? 0), 0);

  const detalle = [
    ...cancelados.map(descripcionItemLog),
    ...demorados.map(descripcionItemLog),
    ...conLeyenda.filter((i) => !i.r.servicio.cancelacion).map(descripcionItemLog),
    ...errores.map((e) => `ERROR/SIN DATOS: ${e}`),
  ];
  const firma = detalle.join("|");
  chequeosDesdeUltimoLatido += 1;
  if (firma === firmaBarridoAnterior && chequeosDesdeUltimoLatido < 12) return;
  const huboCambio = firma !== firmaBarridoAnterior;
  firmaBarridoAnterior = firma;
  chequeosDesdeUltimoLatido = 0;

  console.log(
    `Resumen proxy (${origen})${huboCambio ? "" : " [latido, sin cambios]"}: ${todos.length} servicios · ${cancelados.length} cancelados · ${demorados.length} con demora ${UMBRAL_DEMORA_MIN}+ min (máx ${maxDemora} min) · ${conLeyenda.length} con leyenda · ${errores.length} estación(es) con error/sin datos`
  );
  for (const l of detalle.slice(0, 15)) console.log(`  ${l}`);
  if (detalle.length > 15) console.log(`  … y ${detalle.length - 15} más`);
}

let vistosEnMemoria = new Set();
const nivelesDemora = new Map(); // claveDia -> nivel ya avisado (respaldo sin Firestore) // respaldo sin Firestore y para no repetir dentro del mismo proceso

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
  if (!nuevos.length) return { nuevos: [], texto: null };

  const lineas = nuevos.map((item) => {
    const d = datosServicio(item);
    return `• #${d.s.numero ?? "?"} → ${d.destino} | sale de ${d.origenReal} (se lo vio en ${d.est.nombre}) · prog ${hora(d.prog)}${d.anden ? ` · andén ${d.anden}` : ""}`;
  });
  const texto =
    `🔀 ${nuevos.length} tren(es) con estación de origen distinta a la habitual (Once/Flores/Merlo/Moreno):\n\n` +
    lineas.join("\n") +
    `\n\n(Esto es lo que declara el proxy como estación de salida — se detecta antes de que el tren realmente salga, en cuanto figura "Programado". Sin confirmar todavía si "origen" es 100% ese campo — revisar con /apptrenes get si algo no cierra.)`;
  return { nuevos, texto };
}

// Trenes que aparecen demorados 10+ min. Igual mecánica que las
// cancelaciones: una vez avisado un tren para un día, no se repite aunque la
// demora fluctúe un poco. Si al chequeo siguiente la demora creció mucho
// más, sí conviene poder volver a avisar — no implementado todavía (queda
// para pulir si hace falta).
export async function chequearDemorasProxy() {
  if (!monitorProxyActivo()) return { nuevas: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado(); // comparte caché con el resto de los chequeos
  } catch (err) {
    console.error("Error consultando el proxy de la app para demoras:", err.message);
    return { nuevas: [], texto: null, error: err.message };
  }

  const demorados = barrido.todos.filter((item) => {
    const d = datosServicio(item);
    return !d.s.cancelacion && d.demora != null && d.demora >= UMBRAL_DEMORA_MIN;
  });

  const nuevos = [];
  for (const item of demorados) {
    const clave = claveCancelacion(item); // misma forma de clave (numero-estacion-dia), colección distinta
    const dia = (() => {
      const d = datosServicio(item);
      return d.prog ? new Date(d.prog).toISOString().slice(0, 10) : "s-fecha";
    })();
    const claveDia = `${datosServicio(item).s.numero ?? "s-num"}-${dia}`;
    if (vistosEnMemoria.has(`demora:${claveDia}`)) continue;
    const firestore = ensureInit();
    let visto = false;
    if (firestore) {
      try {
        visto = (await firestore.collection(COLECCION_DEMORAS).doc(claveDia).get()).exists;
      } catch (err) {
        console.error("Error chequeando demora vista:", err.message);
      }
    }
    if (visto) continue;
    vistosEnMemoria.add(`demora:${claveDia}`);
    nivelesDemora.set(claveDia, nivelDemora(datosServicio(item).demora ?? 0));
    if (firestore) firestore.collection(COLECCION_DEMORAS).doc(claveDia).set({ timestamp: FieldValue.serverTimestamp(), nivel: nivelDemora(datosServicio(item).demora ?? 0) }).catch((err) => console.error("Error guardando demora avisada:", err.message));
    nuevos.push(item);
  }

  if (!nuevos.length) return { nuevos: [], texto: null };
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
    `\n\n(Detectado por el proxy no oficial. Se publicó en el grupo.)`;
  const textosGrupo = nuevos.map((item) => {
    const d = datosServicio(item);
    return `⏰ El tren con destino ${d.destino}, programado para las ${hora(d.prog)} (${d.est.nombre}), sale demorado (~${d.demora} min, estimado ${hora(d.estim)}).${etiquetaGrupoLocal(item)}`;
  });
  return { nuevos, texto, textosGrupo };
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
  const textosGrupo = nuevas.map((item) => {
    const d = datosServicio(item);
    return `🚨 Se canceló el tren con destino ${d.destino}, programado para las ${hora(d.prog)} (${d.est.nombre}). ${textoCancelacion(d.s.cancelacion)}.${etiquetaGrupoLocal(item)}`;
  });
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


// ─────────────────────────────────────────────────────────────────────────
// Más cobertura del servicio (oct 2026). Todo esto avisa al admin por privado; solo
// las demoras que empeoran se publican en el grupo (igual que la demora original).
// ─────────────────────────────────────────────────────────────────────────
const diaDe = (prog) => (prog ? new Date(prog).toISOString().slice(0, 10) : "s-fecha");
const hashCorto = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 20);
const normTexto = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function marcarSiNueva(coleccion, clave) {
  if (vistosEnMemoria.has(`${coleccion}:${clave}`)) return false;
  vistosEnMemoria.add(`${coleccion}:${clave}`);
  const firestore = ensureInit();
  if (!firestore) return true;
  try {
    const ref = firestore.collection(coleccion).doc(clave);
    if ((await ref.get()).exists) return false;
    ref.set({ timestamp: FieldValue.serverTimestamp() }).catch((err) => console.error(`Error guardando ${coleccion}:`, err.message));
  } catch (err) {
    console.error(`Error chequeando ${coleccion}:`, err.message);
  }
  return true;
}

// Leyendas: el texto libre que la app de Trenes Argentinos pone en un servicio (obras, accidente,
// "servicio con demoras", etc.). Hasta ahora solo llegaban al bot cuando alguien preguntaba.
// Una vez por texto y por día. Al grupo SOLO si LEYENDAS_AVISO_GRUPO=true (por defecto va solo al admin,
// porque el texto es de la app y puede ser técnico o confuso).
export async function chequearLeyendasProxy() {
  if (!monitorProxyActivo()) return { nuevas: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error("Error consultando el proxy para leyendas:", err.message);
    return { nuevas: [], texto: null, error: err.message };
  }
  const porTexto = new Map();
  for (const item of barrido.todos) {
    const s = item.r?.servicio;
    if (!s?.leyenda || s.cancelacion) continue; // las cancelaciones ya tienen su propio aviso
    const k = normTexto(typeof s.leyenda === "string" ? s.leyenda : JSON.stringify(s.leyenda));
    if (!k) continue;
    if (!porTexto.has(k)) porTexto.set(k, { texto: typeof s.leyenda === "string" ? s.leyenda.trim() : JSON.stringify(s.leyenda), items: [] });
    porTexto.get(k).items.push(item);
  }
  const nuevas = [];
  for (const [k, g] of porTexto) {
    const dia = diaDe(datosServicio(g.items[0]).prog);
    if (await marcarSiNueva(COLECCION_LEYENDAS, `${hashCorto(k)}-${dia}`)) nuevas.push(g);
  }
  if (!nuevas.length) return { nuevas: [], texto: null };
  const alGrupo = String(process.env.LEYENDAS_AVISO_GRUPO ?? "false").trim().toLowerCase() === "true";
  const texto =
    `📢 La app de Trenes Argentinos muestra ${nuevas.length === 1 ? "una leyenda nueva" : `${nuevas.length} leyendas nuevas`}:\n\n` +
    nuevas
      .map((g) => {
        const trenes = g.items.slice(0, 5).map((i) => {
          const d = datosServicio(i);
          return `   • #${d.s.numero ?? "?"} ${d.est.nombre} → ${d.destino} · prog ${hora(d.prog)}`;
        });
        return `"${g.texto.slice(0, 400)}"\n${trenes.join("\n")}${g.items.length > 5 ? `\n   … y ${g.items.length - 5} más` : ""}`;
      })
      .join("\n\n") +
    `\n\n(Detectado por el proxy no oficial. ${alGrupo ? "Se publicó en el grupo." : "No se publicó en el grupo: LEYENDAS_AVISO_GRUPO=true para publicarlas."})`;
  const textosGrupo = alGrupo ? nuevas.map((g) => `📢 La app de Trenes Argentinos informa: "${g.texto.slice(0, 300)}"`) : [];
  return { nuevas, texto, textosGrupo };
}

// Demoras que EMPEORAN: la primera demora de 10+ min ya se avisó (chequearDemorasProxy) y no se repite,
// así que un tren que pasa de 10 a 60 min quedaba en silencio. Acá se vuelve a avisar cada +20 min.
export async function chequearDemorasEscaladas() {
  if (!monitorProxyActivo()) return { nuevos: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error("Error consultando el proxy para demoras que empeoran:", err.message);
    return { nuevos: [], texto: null, error: err.message };
  }
  const peor = new Map(); // numero-dia -> item con la mayor demora
  for (const item of barrido.todos) {
    const d = datosServicio(item);
    if (d.s.cancelacion || d.demora == null || nivelDemora(d.demora) < 1) continue;
    const clave = `${d.s.numero ?? "s-num"}-${diaDe(d.prog)}`;
    if (!peor.has(clave) || d.demora > datosServicio(peor.get(clave)).demora) peor.set(clave, item);
  }
  const nuevos = [];
  const firestore = ensureInit();
  for (const [clave, item] of peor) {
    const nivel = nivelDemora(datosServicio(item).demora);
    let avisado = nivelesDemora.get(clave);
    if (avisado == null && firestore) {
      try {
        const doc = await firestore.collection(COLECCION_DEMORAS).doc(clave).get();
        if (doc.exists) avisado = doc.data()?.nivel ?? 0;
      } catch (err) {
        console.error("Error chequeando nivel de demora:", err.message);
      }
    }
    if (avisado == null) continue; // todavía no se avisó la demora inicial: lo hace chequearDemorasProxy
    if (nivel <= avisado) continue;
    nivelesDemora.set(clave, nivel);
    if (firestore) firestore.collection(COLECCION_DEMORAS).doc(clave).set({ timestamp: FieldValue.serverTimestamp(), nivel }).catch((err) => console.error("Error guardando nivel de demora:", err.message));
    nuevos.push(item);
  }
  if (!nuevos.length) return { nuevos: [], texto: null };
  const texto =
    `⏰📈 ${nuevos.length} demora(s) que EMPEORAN (ya se había avisado antes con menos):\n\n` +
    nuevos
      .map((item) => {
        const d = datosServicio(item);
        return `• #${d.s.numero ?? "?"} → ${d.destino} | ${d.est.nombre}: prog ${hora(d.prog)} / est ${hora(d.estim)} (+${d.demora} min)`;
      })
      .join("\n") +
    `\n\n(Se publicó en el grupo.)`;
  const textosGrupo = nuevos.map((item) => {
    const d = datosServicio(item);
    return `⏰ La demora del tren con destino ${d.destino}, programado para las ${hora(d.prog)} (${d.est.nombre}), sigue aumentando: ahora ~${d.demora} min (estimado ${hora(d.estim)}).${etiquetaGrupoLocal(item)}`;
  });
  return { nuevos, texto, textosGrupo };
}

// Servicios de Sarmiento que el filtro Once–Moreno deja afuera (Merlo–Las Heras, Morón–Luján, etc.).
// No se informan al grupo, pero un accidente en Merlo los afecta: si tienen cancelación o leyenda,
// se avisa SOLO al admin para que decida.
export async function chequearFueraDeTramoProxy() {
  if (!monitorProxyActivo()) return { nuevos: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error("Error consultando el proxy para servicios fuera del tramo:", err.message);
    return { nuevos: [], texto: null, error: err.message };
  }
  const nuevos = [];
  for (const item of barrido.fueraTramo || []) {
    const s = item.r?.servicio || {};
    if (!s.cancelacion && !s.leyenda) continue;
    const d = datosServicio(item);
    const clave = `${s.numero ?? "s-num"}-${hashCorto(`${textoCancelacion(s.cancelacion) || ""}|${normTexto(s.leyenda)}`)}-${diaDe(d.prog)}`;
    if (await marcarSiNueva(COLECCION_FUERA_TRAMO, clave)) nuevos.push(item);
  }
  if (!nuevos.length) return { nuevos: [], texto: null };
  const texto =
    `🚆➡️ ${nuevos.length} servicio(s) FUERA del tramo Once–Moreno con cancelación o leyenda (no se publican en el grupo):\n\n` +
    nuevos
      .slice(0, 8)
      .map((item) => {
        const d = datosServicio(item);
        let l = `• #${d.s.numero ?? "?"} ${d.est.nombre} → ${d.destino} · prog ${hora(d.prog)}`;
        if (d.s.cancelacion) l += `\n   ❌ ${textoCancelacion(d.s.cancelacion)}`;
        if (d.s.leyenda) l += `\n   📢 ${String(d.s.leyenda).replace(/\s+/g, " ").slice(0, 200)}`;
        return l;
      })
      .join("\n") +
    (nuevos.length > 8 ? `\n… y ${nuevos.length - 8} más` : "");
  return { nuevos, texto };
}

// Trenes detenidos por GPS (ver trenDetenido.js). Al grupo SOLO si TREN_DETENIDO_AVISO_GRUPO=true:
// el GPS puede estar congelado sin que el tren lo esté, así que por defecto lo confirma el admin.
const estadoDetenidos = crearEstadoDetenidos();
export async function chequearTrenesDetenidos() {
  if (!monitorProxyActivo() || !detectorDetenidosActivo()) return { nuevos: [], texto: null, desactivado: true };
  let barrido;
  try {
    barrido = await barridoEstructurado();
  } catch (err) {
    console.error("Error consultando el proxy para trenes detenidos:", err.message);
    return { nuevos: [], texto: null, error: err.message };
  }
  const nuevos = detectarDetenidos(barrido.todos, estadoDetenidos, barrido.momento || Date.now());
  if (!nuevos.length) return { nuevos: [], texto: null };
  const alGrupo = String(process.env.TREN_DETENIDO_AVISO_GRUPO ?? "false").trim().toLowerCase() === "true";
  const texto =
    `🛑 ${nuevos.length} tren(es) SIN MOVERSE según el GPS de la app:\n\n` +
    nuevos
      .map((n) => `• #${n.numero} → ${n.destino} · ${n.lugar} · lleva ~${n.minutos} min en el mismo punto${n.estim ? ` (est ${hora(n.estim)})` : ""}${n.cercanos.length ? `\n   ⚠️ Hay otros trenes detenidos cerca (${n.cercanos.map((c) => `#${c}`).join(", ")}): posible incidente en la vía.` : ""}\n   https://maps.google.com/?q=${n.gps.lat},${n.gps.long}`)
      .join("\n") +
    `\n\n(Ojo: es el GPS del proxy no oficial; puede estar congelado aunque el tren se mueva. ${alGrupo ? "Se publicó en el grupo." : "No se publicó en el grupo: TREN_DETENIDO_AVISO_GRUPO=true para publicarlo."})`;
  const textosGrupo = alGrupo
    ? nuevos.map((n) => `🛑 El tren con destino ${n.destino} lleva unos ${n.minutos} min detenido ${n.lugar}.${n.cercanos.length ? " Hay más trenes detenidos en la zona." : ""}`)
    : [];
  return { nuevos, texto, textosGrupo };
}

// Salud del proxy: si la API de terceros falla o devuelve vacío en horario de servicio, el bot queda
// "ciego" sin avisar (hasta ahora solo quedaba en el log). Avisa al admin tras varios chequeos seguidos.
let chequeosMalos = 0;
let avisoCaidoEnviado = false;
const FALLAS_SEGUIDAS_PARA_AVISAR = 3;
export async function chequearSaludProxy() {
  if (!monitorProxyActivo()) return { texto: null, desactivado: true };
  let motivo = null;
  try {
    const barrido = await barridoEstructurado();
    const duros = (barrido.errores || []).filter((e) => !/sin servicios de Sarmiento/i.test(e));
    const horaAR = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false }).format(new Date()));
    const horarioDeServicio = horaAR >= 5 && horaAR < 23;
    if (duros.length >= 8) motivo = `${duros.length} de 16 estaciones dieron error. Ej.: ${duros.slice(0, 2).join(" | ").slice(0, 300)}`;
    else if (horarioDeServicio && barrido.todos.length === 0 && !(barrido.fueraTramo || []).length) motivo = "el proxy responde pero no devuelve ningún servicio de Sarmiento en horario de servicio";
  } catch (err) {
    motivo = `error consultando el proxy: ${err.message}`;
  }
  if (motivo) {
    chequeosMalos += 1;
    if (chequeosMalos >= FALLAS_SEGUIDAS_PARA_AVISAR && !avisoCaidoEnviado) {
      avisoCaidoEnviado = true;
      return { texto: `🔌 El bot está SIN DATOS del proxy de Trenes Argentinos hace ${chequeosMalos} chequeos seguidos (~${Math.round(chequeosMalos * 2.5)} min): ${motivo}.\n\nMientras tanto no detecta cancelaciones, demoras ni trenes detenidos. Revisá que ariedro.dev esté en pie o configurá TRENES_PROXY_URL con otra instancia.` };
    }
    return { texto: null, malos: chequeosMalos };
  }
  const estabaCaido = avisoCaidoEnviado;
  chequeosMalos = 0;
  avisoCaidoEnviado = false;
  return { texto: estabaCaido ? "✅ El proxy de Trenes Argentinos volvió a responder: el bot recuperó los datos." : null };
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

  const relevantes = barrido.todos.filter((item) => item.r?.servicio?.cancelacion || item.r?.servicio?.leyenda);
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
    `\nEsto es lo que se detecta EN ESTE MOMENTO (no vencido, no hay que calcular vigencia): tiene la misma prioridad que los avisos de la fuente de verdad por texto. Nunca menciones cómo se obtuvo este dato ni nombres de sistemas o mecanismos internos. Un tren específico cancelado no implica que todo el ramal esté cortado; hablá solo del/de los tren(es) que aparecen acá salvo que haya varios en el mismo tramo y horario.`;

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
