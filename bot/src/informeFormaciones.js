// src/informeFormaciones.js
// Informe por formación en las cabeceras (Once y Moreno): tipo de servicio (local,
// diferencial o común), hora programada de arribo, hora real de llegada y hora real de
// salida, con demoras y tiempo en cabecera. Uso (admin): /formaciones informe [fecha]
//
// Fuente: lo que guarda la vigilancia de 30 s (vigiaSalidas.js) en las colecciones
// salidasFormaciones y llegadasFormaciones. La llegada y la salida de una misma formación
// llevan números de servicio distintos, así que se las empareja con el cronograma
// (paresCabecera en schedule.js): es un emparejamiento ESTIMADO, no un dato de la app.
// Los datos de llegada se registran desde que está desplegada la versión que las guarda.

import { leerRegistrosDia } from "./vigiaSalidas.js";
import { paresCabecera, getDayType, minutoDelDia } from "./schedule.js";
import { hora } from "./appTrenes.js";

const TZ = "America/Argentina/Buenos_Aires";
const CABECERAS = ["Once", "Moreno"];
const TIPOS = { comun: "Común", local: "Local", diferencial: "Diferencial" };
const TOLERANCIA_MIN = 2;

const ms = (iso) => (iso ? new Date(iso).getTime() : null);
const min1 = (n) => (Math.round(n * 10) / 10).toString().replace(".", ",");
const difMin = (realIso, progIso) => (realIso && progIso ? Math.round((ms(realIso) - ms(progIso)) / 60000) : null);
const conSigno = (n) => (n == null ? "s/d" : n > 0 ? `+${n}` : `${n}`);
const prom = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// "YYYYMMDD" de hoy/ayer/fecha pedida, en hora de Buenos Aires.
export function parsearFecha(arg = "") {
  const t = String(arg).trim().toLowerCase();
  const hoyBA = new Date(Date.now() - 3 * 3600 * 1000);
  let d = null;
  if (!t || t === "hoy") d = hoyBA;
  else if (t === "ayer") d = new Date(hoyBA.getTime() - 24 * 3600 * 1000);
  else {
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else if ((m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/))) {
      const anio = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : hoyBA.getUTCFullYear();
      d = new Date(Date.UTC(anio, +m[2] - 1, +m[1]));
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  const mediodia = new Date(`${iso}T15:00:00Z`); // 12:00 en Buenos Aires: el día de semana no se corre
  return {
    fecha: iso.replace(/-/g, ""),
    dia: getDayType(mediodia),
    titulo: new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(mediodia),
  };
}

// Une cada salida con su llegada (si hay) usando el cronograma; lo que no se une queda suelto.
function armarFilas(cab, salidas, llegadas, dia) {
  const { pares } = paresCabecera(dia, cab);
  const usadas = new Set();
  const filas = [];
  const minDe = (d) => (d.programada ? minutoDelDia(d.programada) : null);
  const coincide = (m, objetivo) => m != null && (Math.abs(m - objetivo) <= TOLERANCIA_MIN || Math.abs(m + 1440 - objetivo) <= TOLERANCIA_MIN);

  for (const s of salidas) {
    let llegada = null;
    if (s.tipoServicio === "diferencial") {
      // Una sola vuelta por día: la que llega a Once por la mañana es la que sale a la tarde.
      if (cab === "Once") llegada = llegadas.find((l) => !usadas.has(l) && l.tipoServicio === "diferencial") || null;
    } else {
      const m = minDe(s);
      const par = pares.find((p) => String(p.sale.n) === String(s.numero)) || pares.find((p) => coincide(m, p.sale.min));
      if (par) {
        llegada =
          llegadas.find((l) => !usadas.has(l) && String(l.numero) === String(par.llega.n)) ||
          llegadas.find((l) => !usadas.has(l) && coincide(minDe(l), par.llega.min)) ||
          null;
      }
    }
    if (llegada) usadas.add(llegada);
    filas.push({ cab, salida: s, llegada });
  }
  for (const l of llegadas) if (!usadas.has(l)) filas.push({ cab, salida: null, llegada: l });

  const clave = (f) => ms(f.llegada?.llegoEn) ?? ms(f.salida?.salioEn) ?? 0;
  return filas.sort((a, b) => clave(a) - clave(b));
}

const tiempo = (iso, fuente) => `${hora(iso)}${fuente && fuente !== "real" ? "~" : ""}`;
const nombreTipo = (r) => (r ? TIPOS[r.tipoServicio] || "Común" : null);

function textoFila(f) {
  const { salida: s, llegada: l } = f;
  const tipoL = nombreTipo(l);
  const tipoS = nombreTipo(s);
  const tipo = tipoL && tipoS && tipoL !== tipoS ? `llegó ${tipoL}${l.origen ? ` desde ${l.origen}` : ""} · sale ${tipoS}` : tipoS || `${tipoL}${l?.origen && l.tipoServicio === "local" ? ` desde ${l.origen}` : ""}`;
  const ids = l && s ? `#${l.numero} → #${s.numero}` : s ? `#${s.numero}` : `#${l.numero}`;
  const out = [`🚆 ${ids} · ${tipo}`];

  if (l) {
    out.push(`  Arribo: prog ${hora(l.programada)} · llegó ${tiempo(l.llegoEn, l.fuente)} (${conSigno(difMin(l.llegoEn, l.programada))})`);
  } else if (s) {
    out.push("  Arribo: sin llegada registrada (sale de cocheras o no se la vio llegar)");
  }
  if (s) {
    out.push(`  Salida: prog ${hora(s.programada)} · salió ${tiempo(s.salioEn, s.fuente)} (${conSigno(difMin(s.salioEn, s.programada))})${s.anden ? ` · andén ${s.anden}` : ""}`);
    if (l) out.push(`  En cabecera: ${Math.max(0, Math.round((ms(s.salioEn) - ms(l.llegoEn)) / 60000))} min`);
    else if (s.enEstacionDesde) out.push(`  En andén: desde ${hora(s.enEstacionDesde)} (${Math.max(0, Math.round((ms(s.salioEn) - ms(s.enEstacionDesde)) / 60000))} min)`);
  } else {
    out.push("  Salida: sin salida registrada (va a cocheras o todavía en cabecera)");
  }
  return out.join("\n");
}

function resumen(cab, filas) {
  const ls = filas.map((f) => f.llegada).filter(Boolean);
  const ss = filas.map((f) => f.salida).filter(Boolean);
  const dl = ls.map((l) => difMin(l.llegoEn, l.programada)).filter((x) => x != null);
  const dsal = ss.map((s) => difMin(s.salioEn, s.programada)).filter((x) => x != null);
  // El Diferencial pernocta entre su llegada de la mañana y su salida de la tarde: no entra en la estadía media.
  const est = filas.filter((f) => f.llegada && f.salida && f.salida.tipoServicio !== "diferencial").map((f) => Math.max(0, (ms(f.salida.salioEn) - ms(f.llegada.llegoEn)) / 60000));
  const partes = [`${ss.length} ${ss.length === 1 ? "salida" : "salidas"}`, `${ls.length} ${ls.length === 1 ? "llegada" : "llegadas"}`];
  if (dl.length) partes.push(`demora media de llegada ${prom(dl) >= 0 ? "+" : ""}${min1(prom(dl))} min`);
  if (dsal.length) partes.push(`demora media de salida ${prom(dsal) >= 0 ? "+" : ""}${min1(prom(dsal))} min`);
  if (est.length) partes.push(`estadía media ${min1(prom(est))} min (máx ${Math.round(Math.max(...est))})`);
  return `📊 ${cab}: ${partes.join(" · ")}`;
}

// Locales: salen de una estación intermedia (Flores, Liniers, Merlo, Castelar); no tienen llegada
// a una cabecera que emparejar, así que se informa su salida y el tiempo que esperaron en el andén.
function textoFilaLocal(s) {
  const out = [`🚆 #${s.numero} · Local · ${s.cabecera}${s.destino ? ` → ${s.destino}` : ""}`];
  out.push(`  Salida: prog ${hora(s.programada)} · salió ${tiempo(s.salioEn, s.fuente)} (${conSigno(difMin(s.salioEn, s.programada))})${s.anden ? ` · andén ${s.anden}` : ""}`);
  if (s.enEstacionDesde) out.push(`  En andén: desde ${hora(s.enEstacionDesde)} (${Math.max(0, Math.round((ms(s.salioEn) - ms(s.enEstacionDesde)) / 60000))} min)`);
  return out.join("\n");
}

export async function textoInformeFormaciones(arg = "") {
  const f = parsearFecha(arg);
  if (!f) return "No entendí la fecha. Uso: /formaciones informe [hoy | ayer | AAAA-MM-DD | DD/MM]";
  const { salidas, llegadas } = await leerRegistrosDia(f.fecha);
  if (!salidas.length && !llegadas.length) {
    return `📋 Informe de formaciones — ${f.titulo}\n\nNo hay registros para ese día. (Las llegadas se guardan desde que está desplegada esta versión; las salidas, desde la anterior.)`;
  }

  const bloques = [`📋 Informe de formaciones — ${f.titulo}`];
  for (const cab of CABECERAS) {
    const ss = salidas.filter((x) => x.cabecera === cab).sort((a, b) => ms(a.salioEn) - ms(b.salioEn));
    const ls = llegadas.filter((x) => x.cabecera === cab).sort((a, b) => ms(a.llegoEn) - ms(b.llegoEn));
    if (!ss.length && !ls.length) continue;
    const filas = armarFilas(cab, ss, ls, f.dia);
    bloques.push(`\n━━━ ${cab} ━━━\n${filas.map(textoFila).join("\n\n")}\n\n${resumen(cab, filas)}`);
  }
  const locales = salidas.filter((x) => !CABECERAS.includes(x.cabecera)).sort((a, b) => ms(a.salioEn) - ms(b.salioEn));
  if (locales.length) bloques.push(`\n━━━ Locales ━━━\n${locales.map(textoFilaLocal).join("\n\n")}`);
  bloques.push(
    "\n~ = hora inferida entre dos consultas (±30 s). Llegada = entrada al radio de la cabecera u hora real de la app. " +
      "El par llegada → salida se estima con el cronograma."
  );
  return bloques.join("\n");
}
