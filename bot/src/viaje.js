// src/viaje.js
// Asistente de viaje (experimento de Coco, 4/10): el admin sube a un tren y el bot lo sigue en vivo,
// le avisa POR PRIVADO en cada estación (hora real, demora, cuántas paradas faltan, llegada estimada)
// y, al terminar, arma un resumen para responder dos preguntas:
//   1) ¿las demoras que informa la app son reales?  → compara lo que la app decía un rato antes de
//      cada estación (demora declarada) contra la hora real en que el tren llegó (según su GPS).
//   2) ¿por qué se demora?  → registra detenciones (entre estaciones o permanencias largas), en qué
//      tramo se perdió tiempo y el contexto de ese momento (leyenda de la app, avisos de la fuente de
//      verdad, servicio limitado, cancelaciones en el ramal).
//
// Cómo sigue al tren: cada 30 s consulta al proxy de la app SOLO la próxima estación (y cada 2 ciclos
// la de destino). De ahí saca el GPS de la formación (servicio.location), proyectado sobre el ramal
// (0 = Once … 15 = Moreno), y las horas programada/estimada. Llegada = el GPS cruza la estación (la
// hora se interpola entre dos lecturas); si no hay GPS, se infiere cuando el tren deja de figurar.
//
// Todo se guarda en Firestore (colección viajesAsistente) y se retoma si el bot se reinicia.
// Nunca publica en el grupo: solo escribe al chat privado desde el que se inició.

import { firestoreDb } from "./firestoreStatus.js";
import { barridoEstructurado, serviciosSarmiento, datosServicio, gpsValido, proyectarEnRamal, indiceEstacionRamal, ESTACIONES_BARRIDO, hora } from "./appTrenes.js";
import { avisosVigentes } from "./avisosFuente.js";
import { getTramoLimitado } from "./servicioLimitado.js";

const COLECCION = "viajesAsistente";
const POLL_MS = 30000;
const RADIO_PASO = 0.07;        // fracción de tramo (~150–250 m) antes de la estación que ya cuenta como llegada
const MAX_DIST_EJE_M = 1500;    // GPS más lejos que esto del ramal = dato dudoso
const MOV_MIN = 0.03;           // movimiento mínimo (en estaciones) para considerar que el tren se mueve
const PARADO_MS = 2 * 60 * 1000;        // sin moverse esto entre estaciones = detenido
const PERMANENCIA_LARGA_MS = 3 * 60 * 1000; // en estación esto = permanencia larga
const MAX_VIAJE_MS = 4 * 3600 * 1000;

const NOMBRE = (i) => (ESTACIONES_BARRIDO[i] === "Padua" ? "San Antonio de Padua" : ESTACIONES_BARRIDO[i]);
const r1 = (n) => Math.round(n * 10) / 10;
const num1 = (n) => String(r1(n)).replace(".", ",");
const dem = (n) => (n == null ? "s/d" : Math.abs(n) < 0.5 ? "en hora" : n > 0 ? `+${num1(n)} min` : `${num1(n)} min (adelantado)`);
const hh = (t) => hora(new Date(t).toISOString());
const corto = (v, n = 160) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, n);
const minDe = (a, b) => (new Date(a) - new Date(b)) / 60000;

const viajes = new Map(); // chatId -> viaje
let enviar = async () => {};
let timer = null;

// ───────────────────────── datos del proxy ─────────────────────────
async function datosEn(numero, idx) {
  try {
    const { servicios } = await serviciosSarmiento(ESTACIONES_BARRIDO[idx]);
    const item = servicios.find((it) => String(it.r?.servicio?.numero) === String(numero));
    return item ? datosServicio(item) : null;
  } catch (err) {
    console.error(`viaje: error consultando ${ESTACIONES_BARRIDO[idx]}:`, err.message);
    return null;
  }
}

function posDe(d) {
  const g = d ? gpsValido(d.s?.location) : null;
  if (!g) return null;
  const p = proyectarEnRamal(g.lat, g.long);
  return p && p.distM <= MAX_DIST_EJE_M ? { pos: p.posicion, distM: Math.round(p.distM) } : null;
}

async function contextoMotivos(d) {
  const l = [];
  if (d?.s?.leyenda) l.push(`📢 La app informa: ${corto(d.s.leyenda)}`);
  if (d?.s?.tipo?.nombre && d.s.tipo.nombre !== "Normal") l.push(`Tipo de servicio: ${d.s.tipo.nombre}`);
  try {
    const t = await getTramoLimitado();
    if (t) l.push(`🚧 Servicio limitado vigente (${t.desde}–${t.hasta})${t.motivo ? `: ${t.motivo}` : ""}`);
  } catch { /* sin dato */ }
  try {
    for (const a of (await avisosVigentes()).slice(0, 3)) l.push(`📣 Aviso de la fuente (${String(a.tipo || "").replace("_", " ")}): ${corto(a.resumen, 140)}`);
  } catch { /* sin dato */ }
  try {
    const b = await barridoEstructurado();
    const canc = new Set(b.todos.filter((x) => x.r?.servicio?.cancelacion).map((x) => x.r.servicio.numero));
    if (canc.size) l.push(`❌ ${canc.size} servicio(s) cancelado(s) en el ramal ahora: menos trenes, más espera y más gente por formación`);
  } catch { /* sin dato */ }
  return l;
}

// ───────────────────────── persistencia ─────────────────────────
function serializable(v) {
  const { ocupado, ...resto } = v; // eslint-disable-line no-unused-vars
  return JSON.parse(JSON.stringify(resto));
}
async function guardar(v) {
  const db = firestoreDb();
  if (!db) return;
  try {
    await db.collection(COLECCION).doc(v.id).set(serializable(v), { merge: false });
  } catch (err) {
    console.error("viaje: error guardando en Firestore:", err.message);
  }
}

// ───────────────────────── arranque de un viaje ─────────────────────────
const AYUDA =
  "🧭 Asistente de viaje\n" +
  "/viaje → sube al próximo tren que sale de Moreno hacia Once\n" +
  "/viaje 1234 → sigue ese número de tren (donde esté ahora)\n" +
  "/viaje 14:10 → el tren que sale a esa hora programada de la estación de subida\n" +
  "/viaje desde Liniers a Moreno → otra estación de subida y/o destino\n" +
  "/donde (o escribí \"¿dónde estoy?\") → estado actual del viaje\n" +
  "/viaje off → termina y manda el resumen\n" +
  "Si compartís tu ubicación en tiempo real en este chat, comparo tu GPS con el del tren.";

function parsearArgs(texto) {
  const t = String(texto || "").trim();
  const hm = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  const sinHora = hm ? t.replace(hm[0], " ") : t;
  const nm = sinHora.match(/\b(\d{3,5})\b/);
  const m1 = t.match(/\bdesde\s+(.+?)(?=\s+(?:hasta|a)\s|$)/i);
  const m2 = t.match(/\b(?:hasta|a)\s+(.+?)(?=\s+desde\s|$)/i);
  return {
    numero: nm ? nm[1] : null,
    hora: hm ? `${hm[1].padStart(2, "0")}:${hm[2]}` : null,
    desde: m1 ? indiceEstacionRamal(m1[1]) : null,
    hasta: m2 ? indiceEstacionRamal(m2[1]) : null,
    desdeTxt: m1?.[1] || null,
    hastaTxt: m2?.[1] || null,
  };
}

function agruparTrenes(items) {
  const porTren = new Map();
  for (const item of items) {
    const d = datosServicio(item);
    const idx = indiceEstacionRamal(item.est.nombre);
    if (idx < 0 || d.s.numero == null) continue;
    const k = String(d.s.numero);
    if (!porTren.has(k)) porTren.set(k, { numero: k, destino: d.destino, cancelado: !!d.s.cancelacion, cruces: [], d });
    porTren.get(k).cruces.push({ idx, prog: d.prog, estim: d.estim, demora: d.demora });
  }
  return [...porTren.values()];
}

function sentidoDe(tren) {
  const idxDest = indiceEstacionRamal(tren.destino);
  const cr = tren.cruces.filter((c) => c.prog || c.estim).sort((a, b) => new Date(a.estim || a.prog) - new Date(b.estim || b.prog));
  if (cr.length > 1 && cr[0].idx !== cr[cr.length - 1].idx) return cr[cr.length - 1].idx > cr[0].idx ? 1 : -1;
  if (idxDest >= 0 && cr[0] && idxDest !== cr[0].idx) return idxDest > cr[0].idx ? 1 : -1;
  return /once/i.test(tren.destino || "") ? -1 : 1;
}

export async function iniciarViaje({ chatId, texto }) {
  const args = parsearArgs(texto);
  if (/^\s*(off|fin|terminar|bajar|cerrar|stop)\b/i.test(texto || "")) {
    const v = viajes.get(chatId);
    if (!v) return "No tenés ningún viaje en curso.";
    await cerrarViaje(v, "manual");
    return null; // el resumen se manda como mensaje aparte
  }
  if (/^\s*(ayuda|help|\?)/i.test(texto || "")) return AYUDA;
  const previo = viajes.get(chatId);
  if (previo && !String(texto || "").trim()) return (await textoEstado(previo)) + "\n\n(/viaje off para terminarlo, /viaje <número> para cambiar de tren)";
  if (args.desdeTxt && args.desde < 0) return `No reconozco la estación de subida "${args.desdeTxt}".`;
  if (args.hastaTxt && args.hasta < 0) return `No reconozco la estación de destino "${args.hastaTxt}".`;

  const b = await barridoEstructurado({ forzar: true });
  const trenes = agruparTrenes(b.todos).filter((t) => !t.cancelado);
  if (!trenes.length) return "No veo formaciones en circulación en el proxy de la app ahora mismo. Probá de nuevo en un minuto.";

  let elegido = null;
  let boardIdx = args.desde ?? null;
  let destIdx = args.hasta ?? null;
  let alternativas = [];
  const ahora = Date.now();

  if (args.numero) {
    elegido = trenes.find((t) => t.numero === args.numero);
    if (!elegido) return `No encuentro el tren #${args.numero} en el proxy ahora. ¿Está circulando? Probá /viaje sin número para subir al próximo desde Moreno.`;
    const s = sentidoDe(elegido);
    const pos = posDe(elegido.d);
    if (boardIdx == null) {
      const aprox = pos ? pos.pos : (elegido.cruces.sort((a, b) => new Date(a.estim || a.prog) - new Date(b.estim || b.prog))[0]?.idx ?? (s > 0 ? 0 : 15)) - s;
      boardIdx = Math.max(0, Math.min(15, s > 0 ? Math.floor(aprox + 0.05) : Math.ceil(aprox - 0.05)));
    }
    if (destIdx == null) { const dd = indiceEstacionRamal(elegido.destino); destIdx = dd >= 0 ? dd : (s > 0 ? 15 : 0); }
  } else {
    if (boardIdx == null) boardIdx = 15; // Moreno
    if (destIdx == null) destIdx = boardIdx >= 8 ? 0 : 15;
    const s = Math.sign(destIdx - boardIdx);
    if (!s) return "La estación de subida y la de destino son la misma.";
    const cands = [];
    for (const t of trenes) {
      const c = t.cruces.find((x) => x.idx === boardIdx);
      if (!c) continue;
      const idxDestTren = indiceEstacionRamal(t.destino);
      if (idxDestTren >= 0 && (Math.sign(idxDestTren - boardIdx) !== s || s * (idxDestTren - destIdx) < 0)) continue; // va para otro lado o no llega a tu destino
      const tiempo = c.estim || c.prog;
      if (!tiempo) continue;
      if (args.hora && hora(c.prog) !== args.hora) continue;
      const delta = minDe(tiempo, ahora);
      cands.push({ t, c, delta, clave: delta >= -4 ? delta : 1000 - delta });
    }
    if (!cands.length) return `No encuentro formaciones que salgan de ${NOMBRE(boardIdx)} hacia ${NOMBRE(destIdx)}${args.hora ? ` con salida programada ${args.hora}` : ""}. Probá /viaje <número de tren>.`;
    cands.sort((a, b) => a.clave - b.clave);
    elegido = cands[0].t;
    alternativas = cands.slice(1, 3).map((x) => `#${x.t.numero} ${hora(x.c.prog)}`);
  }

  const sentido = Math.sign(destIdx - boardIdx);
  if (!sentido) return "La estación de subida y la de destino son la misma.";
  const v = {
    id: `${chatId}_${ahora}`, chatId, activo: true, inicio: ahora, numero: elegido.numero, destinoTren: elegido.destino,
    boardIdx, destIdx, sentido, ultimoIdx: boardIdx, estado: "en_marcha", salioTs: null,
    progPorEst: {}, estimPorEst: {}, declarada: {}, eventos: [], paradas: [], contextos: [], muestras: [], comparaciones: [],
    ultimaPos: null, ultimaPosTs: null, posRef: null, posRefTs: null, parado: null, enEstacion: null,
    ultimaDemoraReal: null, demoraSalida: null, ausencias: 0, visto: false, avisoSinRastro: false, avisoCancelado: false, ticks: 0, ultimo: null, userGps: null,
  };
  for (const c of elegido.cruces) { if (c.prog) v.progPorEst[c.idx] = c.prog; if (c.estim) v.estimPorEst[c.idx] = c.estim; if (c.demora != null) v.declarada[c.idx] = c.demora; }
  const pos0 = posDe(elegido.d);
  const cercaDeSubida = !!pos0 && sentido * (pos0.pos - boardIdx) < 0.15;
  v.estado = args.numero ? (cercaDeSubida ? "esperando_salida" : "en_marcha") : (!pos0 || cercaDeSubida ? "esperando_salida" : "en_marcha");
  viajes.set(chatId, v);
  asegurarTimer();
  await guardar(v);

  const cb = elegido.cruces.find((x) => x.idx === boardIdx);
  const lineas = [
    `🧭 Viaje iniciado — tren #${v.numero} hacia ${elegido.destino}`,
    `Subís en ${NOMBRE(boardIdx)}${cb?.prog ? ` (salida prog ${hora(cb.prog)}${cb.demora ? `, app: ${dem(cb.demora)}` : ""})` : ""} y bajás en ${NOMBRE(destIdx)}${v.progPorEst[destIdx] ? ` (llegada prog ${hora(v.progPorEst[destIdx])})` : ""}.`,
    v.estado === "esperando_salida" ? "Todavía no salió: te aviso apenas arranque y en cada estación." : `Ya está en marcha${pos0 ? ` (entre ${NOMBRE(Math.max(0, Math.min(15, Math.floor(pos0.pos))))} y ${NOMBRE(Math.max(0, Math.min(15, Math.ceil(pos0.pos))))})` : ""}. Te aviso en cada estación.`,
    alternativas.length ? `Si no es ese tren: /viaje <número> (otros cercanos: ${alternativas.join(", ")}).` : "Si no es ese tren: /viaje <número>.",
    "Mandá /donde cuando quieras saber dónde estás.",
  ];
  return lineas.join("\n");
}

// ───────────────────────── seguimiento ─────────────────────────
function etaTexto(v, idx) {
  const prog = v.progPorEst[idx];
  const estim = v.estimPorEst[idx];
  const d = v.ultimaDemoraReal ?? v.declarada[idx] ?? null;
  let t = estim || null;
  let origen = "app";
  if (!t && prog && d != null) { t = new Date(new Date(prog).getTime() + d * 60000).toISOString(); origen = "prog + demora actual"; }
  if (!t && prog) { t = prog; origen = "prog"; }
  if (!t) return null;
  const dd = prog ? minDe(t, prog) : null;
  return `${hora(t)}${prog ? ` (prog ${hora(prog)}${dd != null ? `, ${dem(Math.round(dd))}` : ""})` : ""}${origen === "app" ? "" : ` [${origen}]`}`;
}

function paradasQueFaltan(v, idx) {
  return Math.abs(v.destIdx - idx);
}

async function llegada(v, idx, ts, via, d) {
  const prog = v.progPorEst[idx];
  const real = prog ? minDe(ts, prog) : null;
  const decl = v.declarada[idx] ?? null;
  const previa = v.ultimaDemoraReal ?? v.demoraSalida ?? v.declarada[v.boardIdx] ?? null;
  const ev = { idx, estacion: NOMBRE(idx), ts: new Date(ts).toISOString(), prog: prog || null, demoraReal: real != null ? r1(real) : null, demoraDeclarada: decl, via };
  v.eventos.push(ev);
  v.ultimoIdx = idx;
  if (real != null) v.ultimaDemoraReal = r1(real);
  const delta = real != null && previa != null ? real - previa : null;
  ev.deltaTramo = delta != null ? r1(delta) : null;

  const esDestino = idx === v.destIdx;
  const sig = esDestino ? null : idx + v.sentido;
  const L = [];
  L.push(esDestino ? `🏁 Llegaste a ${NOMBRE(idx)} · ${hh(ts)}${via === "inferida" ? " (aprox.)" : ""}` : `🚉 Llegaste a ${NOMBRE(idx)} · ${hh(ts)}${via === "inferida" ? " (aprox.)" : ""}`);
  if (prog) L.push(`Horario: prog ${hora(prog)} → ${dem(real != null ? Math.round(real) : null)}${decl != null ? ` · la app venía diciendo ${dem(decl)}` : ""}`);
  if (!esDestino) {
    const e = etaTexto(v, sig);
    L.push(`Siguiente: ${NOMBRE(sig)}${e ? ` · ${e}` : ""}`);
    const falta = paradasQueFaltan(v, idx);
    const ed = etaTexto(v, v.destIdx);
    L.push(`Te ${falta === 1 ? "queda 1 parada" : `quedan ${falta} paradas`} hasta ${NOMBRE(v.destIdx)}${ed ? ` · llegada est. ${ed}` : ""}`);
  }
  if (delta != null && delta >= 2) {
    const ctx = await contextoMotivos(d);
    ev.contexto = ctx;
    L.push(`⚠️ En el tramo ${NOMBRE(idx - v.sentido)}→${NOMBRE(idx)} se sumaron ${num1(delta)} min de demora.`);
    L.push(...(ctx.length ? ctx : ["Sin causa informada por la app ni por la fuente."]));
    v.contextos.push({ tramo: `${NOMBRE(idx - v.sentido)}→${NOMBRE(idx)}`, delta: r1(delta), lineas: ctx });
  } else if (delta != null && delta <= -2) {
    L.push(`👍 En este tramo recuperó ${num1(-delta)} min.`);
  }
  await enviar(v.chatId, L.join("\n"));
  if (esDestino) await cerrarViaje(v, "destino");
  else await guardar(v);
}

async function tick(v) {
  if (v.ocupado || !v.activo) return;
  v.ocupado = true;
  try {
    if (Date.now() - v.inicio > MAX_VIAJE_MS) { await cerrarViaje(v, "tiempo"); return; }
    v.ticks += 1;
    const prox = v.ultimoIdx + v.sentido;
    const idxConsulta = v.sentido * (v.destIdx - prox) >= 0 ? prox : v.destIdx;
    const [dProx, dDest] = await Promise.all([
      datosEn(v.numero, idxConsulta),
      idxConsulta !== v.destIdx && v.ticks % 2 === 0 ? datosEn(v.numero, v.destIdx) : Promise.resolve(null),
    ]);
    const d = dProx || dDest;
    const t = Date.now();
    const p = posDe(dProx) || posDe(dDest);

    for (const [dd, idx] of [[dProx, idxConsulta], [dDest, v.destIdx]]) {
      if (!dd) continue;
      if (dd.prog) v.progPorEst[idx] = dd.prog;
      if (dd.estim) v.estimPorEst[idx] = dd.estim;
      // La demora "declarada" se captura solo mientras el tren todavía está lejos de la estación, para que no se mezcle con la hora real.
      if (dd.demora != null && (!p || v.sentido * (idx - p.pos) > 0.3)) v.declarada[idx] = dd.demora;
    }

    if (d) { v.visto = true; v.ausencias = 0; v.avisoSinRastro = false; } else v.ausencias += 1;
    if (d?.s?.cancelacion && !v.avisoCancelado) {
      v.avisoCancelado = true;
      await enviar(v.chatId, `❌ Tu tren #${v.numero} figura CANCELADO en la app. Mandá /viaje para subirte al próximo.`);
    }

    v.ultimo = { ts: t, pos: p ? Math.round(p.pos * 100) / 100 : null, demoraDeclarada: dProx?.demora ?? null, idxConsulta };
    if (v.muestras.length < 600) v.muestras.push({ t: new Date(t).toISOString(), pos: p ? Math.round(p.pos * 100) / 100 : null, d: dProx?.demora ?? null });

    if (p) {
      // salida de la estación de subida
      if (v.estado === "esperando_salida" && v.sentido * (p.pos - v.boardIdx) >= 0.15) {
        v.estado = "en_marcha";
        v.salioTs = interpolar(v, v.boardIdx + v.sentido * 0.15, p.pos, t);
        const prog = v.progPorEst[v.boardIdx];
        v.demoraSalida = prog ? r1(minDe(v.salioTs, prog)) : null;
        v.ultimaDemoraReal = v.demoraSalida;
        await enviar(v.chatId, `🚆 Salió de ${NOMBRE(v.boardIdx)} a las ${hh(v.salioTs)}${prog ? ` (prog ${hora(prog)} → ${dem(Math.round(v.demoraSalida))})` : ""}\nSiguiente: ${NOMBRE(v.boardIdx + v.sentido)}${etaTexto(v, v.boardIdx + v.sentido) ? ` · ${etaTexto(v, v.boardIdx + v.sentido)}` : ""}. Hasta ${NOMBRE(v.destIdx)}: ${paradasQueFaltan(v, v.boardIdx)} paradas${etaTexto(v, v.destIdx) ? ` · llegada est. ${etaTexto(v, v.destIdx)}` : ""}.`);
        await guardar(v);
      }
      // llegadas a estaciones (puede saltear varias si hubo un hueco entre lecturas)
      let guard = 0;
      while (v.activo && v.ultimoIdx !== v.destIdx && guard++ < 16) {
        const sig = v.ultimoIdx + v.sentido;
        if (v.estado === "esperando_salida" || v.sentido * (p.pos - sig) < -RADIO_PASO) break;
        await llegada(v, sig, interpolar(v, sig - v.sentido * RADIO_PASO, p.pos, t), "gps", d);
      }
      if (v.activo) await vigilarDetencion(v, p, t, d);
      v.ultimaPos = p.pos;
      v.ultimaPosTs = t;
    } else if (v.visto && v.estado !== "esperando_salida") {
      // Sin GPS usable: si el tren dejó de figurar en la próxima estación 2 ciclos seguidos, se infiere que ya pasó.
      if (!dProx && v.ausencias >= 2 && v.ultimoIdx !== v.destIdx && idxConsulta === v.ultimoIdx + v.sentido) {
        v.ausencias = 0;
        await llegada(v, idxConsulta, t, "inferida", d);
      }
    }
    if (v.activo && !d && v.ausencias >= 8 && !v.avisoSinRastro) {
      v.avisoSinRastro = true;
      await enviar(v.chatId, `⚠️ Perdí el rastro del tren #${v.numero} (la app no lo informa hace unos minutos). Sigo intentando; si te subiste a otro, mandá /viaje <número>.`);
    }
  } catch (err) {
    console.error("viaje: error en tick:", err.message);
  } finally {
    v.ocupado = false;
  }
}

// Hora (ms) en que el tren cruzó la posición `objetivo`, interpolando entre la lectura anterior y la actual.
function interpolar(v, objetivo, posAhora, tAhora) {
  if (v.ultimaPos == null || v.ultimaPosTs == null || posAhora === v.ultimaPos) return tAhora;
  const frac = (objetivo - v.ultimaPos) / (posAhora - v.ultimaPos);
  return Math.round(v.ultimaPosTs + Math.max(0, Math.min(1, frac)) * (tAhora - v.ultimaPosTs));
}

async function vigilarDetencion(v, p, t, d) {
  if (v.estado === "esperando_salida") { v.posRef = p.pos; v.posRefTs = t; return; }
  if (v.posRef == null || Math.abs(p.pos - v.posRef) >= MOV_MIN) {
    if (v.parado) {
      const min = r1((t - v.parado.desde) / 60000);
      v.paradas.push({ desde: new Date(v.parado.desde).toISOString(), hasta: new Date(t).toISOString(), lugar: v.parado.lugar, min });
      const ctx = await contextoMotivos(d);
      v.contextos.push({ tramo: `detenido ${v.parado.lugar}`, delta: null, min, lineas: ctx });
      await enviar(v.chatId, `▶️ Retomó la marcha tras ~${num1(min)} min detenido ${v.parado.lugar}.${ctx.length ? "\nContexto:\n" + ctx.join("\n") : "\nSin causa informada por la app ni por la fuente."}`);
      v.parado = null;
      await guardar(v);
    }
    v.posRef = p.pos;
    v.posRefTs = t;
    return;
  }
  const quieto = t - v.posRefTs;
  const cercaEst = Math.abs(p.pos - Math.round(p.pos)) < 0.1;
  const umbral = cercaEst ? PERMANENCIA_LARGA_MS : PARADO_MS;
  if (!v.parado && quieto >= umbral) {
    const lugar = cercaEst ? `en ${NOMBRE(Math.round(p.pos))}` : `entre ${NOMBRE(v.sentido > 0 ? Math.floor(p.pos) : Math.ceil(p.pos))} y ${NOMBRE(v.sentido > 0 ? Math.ceil(p.pos) : Math.floor(p.pos))}`;
    v.parado = { desde: v.posRefTs, lugar };
    await enviar(v.chatId, `⏸ Tu tren está detenido ${lugar} desde las ${hh(v.posRefTs)} (según el GPS de la app). Te aviso cuando retome y qué contexto hay.`);
    await guardar(v);
  }
}

// ───────────────────────── estado a demanda ─────────────────────────
function textoPosicion(v) {
  const pos = v.ultimo?.pos;
  if (pos == null) return v.estado === "esperando_salida" ? `En ${NOMBRE(v.boardIdx)}, todavía sin salir` : "Sin posición GPS en este momento";
  if (Math.abs(pos - Math.round(pos)) < 0.1) return `En ${NOMBRE(Math.round(pos))}`;
  const a = Math.floor(pos), b = Math.ceil(pos);
  const desde = v.sentido > 0 ? a : b;
  const hacia = v.sentido > 0 ? b : a;
  const avance = Math.round(Math.abs(pos - desde) * 100);
  return `Entre ${NOMBRE(desde)} y ${NOMBRE(hacia)} (${avance}% del tramo)`;
}

async function textoEstado(v) {
  if (!v.ocupado) await tick(v);
  if (!viajes.has(v.chatId)) return "El viaje ya terminó."; // el tick pudo cerrarlo
  const L = [`📍 Tren #${v.numero} → ${v.destinoTren}`];
  L.push(textoPosicion(v) + (v.ultimo?.ts ? ` · dato de las ${hh(v.ultimo.ts)}` : ""));
  const ult = v.eventos[v.eventos.length - 1];
  if (ult) L.push(`Última estación: ${ult.estacion} a las ${hh(ult.ts)} (${dem(ult.demoraReal != null ? Math.round(ult.demoraReal) : null)})`);
  const sig = v.ultimoIdx + v.sentido;
  if (v.ultimoIdx !== v.destIdx) {
    const e = etaTexto(v, sig);
    L.push(`Próxima: ${NOMBRE(sig)}${e ? ` · ${e}` : ""}`);
    const falta = paradasQueFaltan(v, v.ultimoIdx);
    const ed = etaTexto(v, v.destIdx);
    L.push(`Te ${falta === 1 ? "queda 1 parada" : `quedan ${falta} paradas`} hasta ${NOMBRE(v.destIdx)}${ed ? ` · llegada est. ${ed}` : ""}`);
  }
  if (v.ultimaDemoraReal != null) L.push(`Demora real acumulada: ${dem(Math.round(v.ultimaDemoraReal))}`);
  if (v.parado) L.push(`⏸ Detenido ${v.parado.lugar} desde las ${hh(v.parado.desde)}`);
  if (v.userGps && Date.now() - v.userGps.t < 3 * 60 * 1000 && v.ultimo?.pos != null) {
    L.push(`📱 Tu celular: ${NOMBRE(Math.round(v.userGps.pos))} aprox. (a ${v.userGps.distM} m de las vías) · diferencia con el tren: ${num1(Math.abs(v.userGps.pos - v.ultimo.pos))} estaciones`);
  }
  return L.join("\n");
}

export async function estadoViaje(chatId) {
  const v = viajes.get(chatId);
  return v ? textoEstado(v) : null;
}

// Ubicación (en vivo) que comparte el admin por Telegram: se compara con la del tren como dato extra de precisión.
export function ubicacionUsuario(chatId, lat, long, precision) {
  const v = viajes.get(chatId);
  if (!v || !Number.isFinite(lat) || !Number.isFinite(long)) return false;
  const p = proyectarEnRamal(lat, long);
  if (!p) return false;
  v.userGps = { t: Date.now(), pos: p.posicion, distM: Math.round(p.distM), precision: Number.isFinite(precision) ? Math.round(precision) : null };
  if (v.ultimo?.pos != null && Date.now() - v.ultimo.ts < 90000 && v.comparaciones.length < 600) {
    v.comparaciones.push({ t: new Date().toISOString(), userPos: Math.round(p.posicion * 100) / 100, userDistM: Math.round(p.distM), precisionM: v.userGps.precision, trenPos: v.ultimo.pos, dif: Math.round(Math.abs(p.posicion - v.ultimo.pos) * 100) / 100 });
  }
  return true;
}

// ───────────────────────── cierre y resumen ─────────────────────────
function resumen(v, motivo) {
  const L = [`📊 Resumen del viaje — tren #${v.numero}, ${NOMBRE(v.boardIdx)} → ${NOMBRE(v.destIdx)}${motivo === "manual" ? " (terminado a mano)" : motivo === "tiempo" ? " (cortado por tiempo máximo)" : ""}`];
  const ult = v.eventos[v.eventos.length - 1];
  const progSal = v.progPorEst[v.boardIdx];
  if (v.salioTs) L.push(`Salida real ${hh(v.salioTs)}${progSal ? ` (prog ${hora(progSal)}, ${dem(v.demoraSalida != null ? Math.round(v.demoraSalida) : null)})` : ""}`);
  if (ult) {
    const dur = v.salioTs ? Math.round((new Date(ult.ts) - v.salioTs) / 60000) : null;
    const durProg = progSal && ult.prog ? Math.round(minDe(ult.prog, progSal)) : null;
    L.push(`${ult.estacion}: ${hh(ult.ts)}${ult.prog ? ` (prog ${hora(ult.prog)}, ${dem(ult.demoraReal != null ? Math.round(ult.demoraReal) : null)})` : ""}${dur != null && durProg != null ? ` · viaje de ${dur} min (programado ${durProg})` : ""}`);
  }

  const comp = v.eventos.filter((e) => e.demoraReal != null && e.demoraDeclarada != null);
  L.push("\n¿Las demoras de la app son reales?");
  if (comp.length >= 2) {
    const dif = comp.map((e) => e.demoraReal - e.demoraDeclarada);
    const abs = dif.map(Math.abs);
    const prom = abs.reduce((a, b) => a + b, 0) / abs.length;
    const sesgo = dif.reduce((a, b) => a + b, 0) / dif.length;
    L.push(`• ${comp.length} estaciones comparadas: la app se equivocó en promedio ${num1(prom)} min${Math.abs(sesgo) >= 0.5 ? ` (en general ${sesgo > 0 ? "subestimaba" : "sobrestimaba"} la demora en ${num1(Math.abs(sesgo))} min)` : " (sin sesgo claro)"}.`);
    L.push("• app/real por estación: " + comp.map((e) => `${e.estacion} ${e.demoraDeclarada >= 0 ? "+" : ""}${e.demoraDeclarada}/${e.demoraReal >= 0 ? "+" : ""}${Math.round(e.demoraReal)}`).join(" · "));
  } else {
    L.push("• Pocos datos para comparar (la app no informó demora o no hubo GPS). Con más viajes se afina.");
  }

  const tramos = v.eventos.filter((e) => e.deltaTramo != null && Math.abs(e.deltaTramo) >= 1.5).sort((a, b) => Math.abs(b.deltaTramo) - Math.abs(a.deltaTramo)).slice(0, 4);
  if (tramos.length) {
    L.push("\nDónde se ganó/perdió tiempo:");
    for (const e of tramos) L.push(`• ${NOMBRE(e.idx - v.sentido)}→${e.estacion}: ${e.deltaTramo > 0 ? "perdió" : "ganó"} ${num1(Math.abs(e.deltaTramo))} min`);
  }
  if (v.paradas.length) {
    L.push("\nDetenciones:");
    for (const p of v.paradas) L.push(`• ${hh(new Date(p.desde))}: ${num1(p.min)} min detenido ${p.lugar}`);
  }
  const lineasCtx = [...new Set(v.contextos.flatMap((c) => c.lineas || []))];
  L.push("\nPosibles motivos:");
  L.push(lineasCtx.length ? lineasCtx.map((x) => `• ${x}`).join("\n") : "• Ninguna causa informada por la app ni por la fuente de verdad durante el viaje" + (v.paradas.length || tramos.length ? " — las pérdidas de tiempo quedaron registradas pero sin explicación oficial." : "."));
  if (v.comparaciones.length) {
    const d = v.comparaciones.map((c) => c.dif).sort((a, b) => a - b);
    L.push(`\n📱 Celular vs tren (${d.length} lecturas): diferencia mediana ${num1(d[Math.floor(d.length / 2)])} estaciones.`);
  }
  if (firestoreDb()) L.push("\nTodo quedó guardado en Firestore (viajesAsistente).");
  return L.join("\n").slice(0, 3900);
}

async function cerrarViaje(v, motivo) {
  if (!v.activo) return;
  v.activo = false;
  v.fin = Date.now();
  v.motivoCierre = motivo;
  viajes.delete(v.chatId);
  if (v.parado) {
    v.paradas.push({ desde: new Date(v.parado.desde).toISOString(), hasta: new Date().toISOString(), lugar: v.parado.lugar, min: r1((Date.now() - v.parado.desde) / 60000) });
    v.parado = null;
  }
  try { await enviar(v.chatId, resumen(v, motivo)); } catch (err) { console.error("viaje: error mandando resumen:", err.message); }
  await guardar(v);
}

// ───────────────────────── arranque del servicio ─────────────────────────
function asegurarTimer() {
  if (timer) return;
  timer = setInterval(() => {
    for (const v of viajes.values()) tick(v).catch((e) => console.error("viaje: tick:", e.message));
  }, POLL_MS);
}

// Retoma viajes que estaban en curso si el bot se reinició (hasta 4 h de antigüedad).
async function restaurar() {
  const db = firestoreDb();
  if (!db) return;
  try {
    const snap = await db.collection(COLECCION).where("activo", "==", true).get();
    for (const doc of snap.docs) {
      const v = doc.data();
      if (!v.chatId || Date.now() - v.inicio > MAX_VIAJE_MS) { await doc.ref.set({ activo: false, motivoCierre: "vencido" }, { merge: true }); continue; }
      v.ocupado = false;
      viajes.set(v.chatId, v);
    }
    if (viajes.size) { asegurarTimer(); console.log(`viaje: retomados ${viajes.size} viaje(s) en curso`); }
  } catch (err) {
    console.error("viaje: error restaurando viajes:", err.message);
  }
}

export function iniciarViajes({ enviar: fn }) {
  enviar = fn;
  restaurar();
}

export const hayViajeActivo = (chatId) => viajes.has(chatId);
