// src/estadoAuto.js
// Semáforo automático (a pedido de Coco, 29/9): cada vez que corre el chequeo
// periódico del proxy, el bot decide solo si el estado del sitio debe ser
// "Normal" o "Servicio completo con algunas demoras".
//
//  - Hay anomalías suficientes (3+ puntos: demora de 10+ min = 1, cancelación
//    = 2, sobre trenes distintos en el proxy; o 3+ cuentas distintas del grupo
//    reportando demoras/cancelaciones en 30 min), confirmadas en 2 chequeos
//    seguidos, y el sitio dice "normal"  →  "modificado" con el mensaje
//    "Servicio completo con algunas demoras. ...".
//    (Si hay cancelaciones, el mensaje no dice "completo": sería falso.)
//  - No hubo anomalías en el proxy ni quejas en el grupo durante la ventana
//    de calma (30 min si el estado lo puso el bot; 90 si lo puso una persona)
//    y el sitio dice "modificado"  →  "normal".
//
// Reglas de seguridad: nunca toca "paro" (interrupción: solo una persona lo
// levanta), ni un estado con vigencia activa (obra/aviso programado), ni
// normaliza si el proxy falló, o si el proceso arrancó hace poco (el rastreo
// de quejas del grupo vive en memoria y no cubriría toda la ventana).
// Cada cambio se avisa por privado al admin. Se apaga con /estadoauto off o
// ESTADO_AUTO=false.

import { getEstadoServicio, actualizarEstadoServicio, firestoreDb } from "./firestoreStatus.js";
import { barridoEstructurado, datosServicio } from "./appTrenes.js";
import { getQuejasRecientes } from "./complaintTracker.js";
import { clasificarServicio } from "./locales.js";

export const EDITOR_AUTO = "Bot automático";
const MIN = 60 * 1000;
const VENTANA_CALMA_AUTO_MIN = 30;
const VENTANA_CALMA_MANUAL_MIN = 90;
const VENTANA_QUEJAS_MIN = 30;
const MIN_CUENTAS_QUEJA = 3;
const UPTIME_MINIMO_MIN = 20;
const DEMORA_MIN = 10;
const PROG_ATRAS_MIN = 45;
const PROG_ADELANTE_MIN = 60;
const MAX_ERRORES_PROXY = 6;
const INICIO_PROCESO = Date.now();
// Anti-parpadeo (3/10): un tren suelto con demora no significa servicio con
// demoras. Cada tren demorado suma 1 punto y cada cancelado 2; hace falta
// PUNTOS_MIN para considerar que el servicio está afectado (p. ej. 3 demorados,
// o 1 cancelado + 1 demorado). Además el cambio a "modificado" exige verlo en
// CONFIRMACIONES_MIN chequeos seguidos, y tras volver a Normal el bot no
// vuelve a "modificado" por COOLDOWN_MIN salvo que sea grave (el doble de puntos).
const PUNTOS_DEMORADO = 1;
const PUNTOS_CANCELADO = 2;
const PUNTOS_MIN = Number(process.env.ESTADO_AUTO_PUNTOS_MIN) || 3;
const CONFIRMACIONES_MIN = 2;
const COOLDOWN_MIN = 20;
// El chequeo lo disparan el cron externo (cada 10-15 min) y el timer interno
// (cada 5 min), sin coordinarse. Para que "2 chequeos seguidos" sean dos
// lecturas distintas del proxy y no la misma repetida, se ignora cualquier
// evaluación que llegue a menos de SEPARACION_MIN minutos de la anterior
// (3 min: deja margen al timer de 5 min aunque un chequeo tarde en correr).
const SEPARACION_MIN = Number(process.env.ESTADO_AUTO_SEPARACION_MIN) || 3;

let activo = String(process.env.ESTADO_AUTO ?? "true").trim().toLowerCase() !== "false";
let ultimaAnomaliaMs = null;
let confirmaciones = 0;
let ultimaEvaluacionMs = null;
let ultimoNormalAutoMs = null;

export const puntosAnomalias = (an) => (an?.demorados || 0) * PUNTOS_DEMORADO + (an?.cancelaciones || 0) * PUNTOS_CANCELADO;

export const estadoAutoActivo = () => activo;

// Solo para pruebas: olvida la última anomalía vista.
export const reiniciarUltimaAnomalia = () => { ultimaAnomaliaMs = null; };

export async function cargarEstadoAuto() {
  const firestore = firestoreDb();
  if (!firestore) return activo;
  try {
    const doc = await firestore.collection("configBot").doc("estadoAuto").get();
    if (doc.exists) {
      const d = doc.data();
      if (typeof d.activo === "boolean") activo = d.activo;
      if (typeof d.ultimaAnomaliaMs === "number") ultimaAnomaliaMs = d.ultimaAnomaliaMs;
    }
    console.log(`Semáforo automático: ${activo ? "ACTIVO" : "apagado"}`);
  } catch (err) {
    console.error("Error cargando estado del semáforo automático:", err.message);
  }
  return activo;
}

export async function setEstadoAuto(valor, quien) {
  activo = !!valor;
  const firestore = firestoreDb();
  if (!firestore) return;
  try {
    await firestore.collection("configBot").doc("estadoAuto").set({ activo, cambiadoPor: quien || null, cambiadoEn: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.error("Error guardando estado del semáforo automático:", err.message);
  }
}

async function persistirAnomalia(ms) {
  const firestore = firestoreDb();
  if (!firestore) return;
  try {
    await firestore.collection("configBot").doc("estadoAuto").set({ ultimaAnomaliaMs: ms }, { merge: true });
  } catch (err) {
    console.error("Error guardando última anomalía:", err.message);
  }
}

// Trenes anormales (cancelados o con demora de 10+ min) cuya salida programada
// cae en la ventana reciente. Un mismo tren en varias estaciones cuenta una vez.
export function anomaliasProxy(barrido, ahoraMs) {
  const porTren = new Map();
  for (const item of barrido?.todos || []) {
    const d = datosServicio(item);
    const progMs = d.prog ? new Date(d.prog).getTime() : NaN;
    if (Number.isNaN(progMs)) continue;
    if (progMs < ahoraMs - PROG_ATRAS_MIN * MIN || progMs > ahoraMs + PROG_ADELANTE_MIN * MIN) continue;
    const cancelado = !!d.s.cancelacion;
    const demorado = d.demora != null && d.demora >= DEMORA_MIN;
    if (!cancelado && !demorado) continue;
    const clave = d.s.numero ?? `${d.est.nombre}-${d.prog}`;
    const reg = { cancelado, demora: d.demora ?? 0, local: clasificarServicio(item).esLocal };
    const prev = porTren.get(clave);
    if (!prev || (reg.cancelado && !prev.cancelado) || reg.demora > prev.demora) porTren.set(clave, reg);
  }
  const lista = [...porTren.values()];
  const demorados = lista.filter((x) => !x.cancelado);
  return {
    lista,
    cancelaciones: lista.filter((x) => x.cancelado).length,
    demorados: demorados.length,
    maxDemora: demorados.reduce((m, x) => Math.max(m, x.demora), 0),
    locales: lista.filter((x) => x.local).length,
  };
}

export function armarMensajeAuto({ cancelaciones = 0, demorados = 0, maxDemora = 0, locales = 0, cuentasQueja = 0 }) {
  const partes = [];
  if (demorados) partes.push(`${demorados} tren${demorados === 1 ? "" : "es"} con demoras${maxDemora ? ` de hasta ${maxDemora} min` : ""}`);
  if (cancelaciones) partes.push(`${cancelaciones} cancelación${cancelaciones === 1 ? "" : "es"}`);
  let detalle = partes.join(" y ");
  if (!detalle && cuentasQueja) detalle = "usuarios del grupo reportan demoras";
  if (locales) detalle += ` (incluye ${locales} local${locales === 1 ? "" : "es"})`;
  const base = cancelaciones ? "Servicio con algunas demoras y cancelaciones." : "Servicio completo con algunas demoras.";
  return `${base} ${detalle ? detalle.charAt(0).toUpperCase() + detalle.slice(1) + ". " : ""}Estado actualizado automáticamente; verificá el horario antes de salir.`;
}

// Devuelve { accion, texto? }. accion: desactivado | sin_datos | sin_estado |
// paro_no_tocar | vigencia_no_tocar | a_modificado | mantiene_modificado |
// a_normal | ya_normal | espera_calma | espera_confirmacion | espera_cooldown |
// espera_separacion
export async function evaluarEstadoAutomatico({ ahora = new Date(), deps = {} } = {}) {
  const {
    getBarrido = () => barridoEstructurado(),
    getEstado = getEstadoServicio,
    setEstado = actualizarEstadoServicio,
    getQuejas = getQuejasRecientes,
    uptimeMs = Date.now() - INICIO_PROCESO,
    persistir = persistirAnomalia,
  } = deps;
  if (!activo) return { accion: "desactivado" };
  const ahoraMs = ahora.getTime();
  // Dos disparadores casi simultáneos no cuentan como dos chequeos distintos.
  if (ultimaEvaluacionMs != null && Math.abs(ahoraMs - ultimaEvaluacionMs) < SEPARACION_MIN * MIN) return { accion: "espera_separacion" };
  ultimaEvaluacionMs = ahoraMs;

  let barrido;
  try {
    barrido = await getBarrido();
  } catch (err) {
    console.error("Semáforo automático: no pude consultar el proxy:", err.message);
    return { accion: "sin_datos" };
  }
  const errores = barrido?.errores?.length ?? 0;
  const proxyConfiable = errores < MAX_ERRORES_PROXY && !((barrido?.todos?.length ?? 0) === 0 && errores > 0);

  const actual = await getEstado().catch(() => null);
  if (!actual) return { accion: "sin_estado" };
  if (actual.estado === "paro") return { accion: "paro_no_tocar" };
  if (actual.vigencia?.hasta) {
    const hasta = new Date(actual.vigencia.hasta);
    hasta.setHours(23, 59, 59, 999);
    if (!Number.isNaN(hasta.getTime()) && hasta.getTime() >= ahoraMs) return { accion: "vigencia_no_tocar" };
  }

  const an = proxyConfiable ? anomaliasProxy(barrido, ahoraMs) : { lista: [], cancelaciones: 0, demorados: 0, maxDemora: 0, locales: 0 };
  const puntos = puntosAnomalias(an);
  const hayProxy = puntos >= PUNTOS_MIN; // un tren suelto no alcanza
  const cuentasQueja = getQuejas(VENTANA_QUEJAS_MIN * MIN);
  const hayGrupo = cuentasQueja >= MIN_CUENTAS_QUEJA;

  if (hayProxy) {
    ultimaAnomaliaMs = ahoraMs;
    persistir(ahoraMs);
  }

  if (hayProxy || hayGrupo) {
    if (actual.estado !== "normal") return { accion: "mantiene_modificado" };
    // Confirmación: tiene que verse en chequeos consecutivos antes de cambiar.
    confirmaciones += 1;
    if (confirmaciones < CONFIRMACIONES_MIN) return { accion: "espera_confirmacion" };
    // Enfriamiento: recién volvió a Normal; solo se re-activa si es grave.
    const grave = puntos >= PUNTOS_MIN * 2 || cuentasQueja >= MIN_CUENTAS_QUEJA * 2;
    if (!grave && ultimoNormalAutoMs != null && ahoraMs - ultimoNormalAutoMs < COOLDOWN_MIN * MIN) return { accion: "espera_cooldown" };
    confirmaciones = 0;
    const mensaje = armarMensajeAuto({ ...an, cuentasQueja: hayGrupo ? cuentasQueja : 0 });
    await setEstado({ estado: "modificado", mensaje, editor: EDITOR_AUTO });
    const motivo = [hayProxy ? `proxy: ${an.demorados} demorado(s), ${an.cancelaciones} cancelado(s)` : null, hayGrupo ? `grupo: ${cuentasQueja} cuentas reportan demoras` : null].filter(Boolean).join(" · ");
    return { accion: "a_modificado", texto: `🚦🤖 Semáforo automático → Servicio con demoras\n"${mensaje}"\n(${motivo})` };
  }

  // Calma: candidato a volver a Normal
  confirmaciones = 0;
  if (actual.estado !== "modificado") return { accion: "ya_normal" };
  if (!proxyConfiable) return { accion: "sin_datos" };
  const esperaMin = actual.editor === EDITOR_AUTO ? VENTANA_CALMA_AUTO_MIN : VENTANA_CALMA_MANUAL_MIN;
  const calmaDesdeAnomalia = ultimaAnomaliaMs == null || ahoraMs - ultimaAnomaliaMs >= esperaMin * MIN;
  const actualizadoMs = actual.actualizado ? new Date(actual.actualizado).getTime() : NaN;
  const calmaDesdeCambio = Number.isNaN(actualizadoMs) || ahoraMs - actualizadoMs >= esperaMin * MIN;
  const quejasEnVentana = getQuejas(esperaMin * MIN);
  const uptimeOk = uptimeMs >= UPTIME_MINIMO_MIN * MIN;
  if (!calmaDesdeAnomalia || !calmaDesdeCambio || quejasEnVentana > 0 || !uptimeOk) return { accion: "espera_calma" };

  await setEstado({ estado: "normal", editor: EDITOR_AUTO });
  ultimoNormalAutoMs = ahoraMs;
  return { accion: "a_normal", texto: `🚦🤖 Semáforo automático → Servicio normal\n(sin cancelaciones ni demoras de 10+ min en el proxy ni quejas en el grupo durante ${esperaMin} min)` };
}
