// src/locales.js
// Identifica si un tren visto en el proxy de la app es un "local" (formación que
// arranca en una estación intermedia: Flores, Liniers, Merlo, Castelar) o uno
// normal (arranca en Once o Moreno), y lo cruza con el cronograma oficial
// (schedule.js) para detectar locales FUERA DE CRONOGRAMA.
//
// Criterio:
//  - Es local si el cronograma lo marca así (por número de tren, o por
//    sentido + estación + hora) O si el proxy declara que sale de una estación
//    que no es Once ni Moreno.
//  - Está fuera de cronograma si es local y: no figura en el cronograma; o el
//    proxy lo muestra saliendo de una estación distinta a la del cronograma
//    (ej. 9775 sale de Liniers en vez de Flores); o, si coincide por número, el
//    horario programado difiere del cronograma más de la tolerancia.
//
// Nota: el cronograma no distingue feriados (usa el tipo de día lv/sab/dom).
// Un local de un feriado puede aparecer como "fuera de cronograma".

import { datosServicio, hora, barridoEstructurado, textoCancelacion } from "./appTrenes.js";
import { buscarEnCronograma, buscarEstacion, getDayType, localesConNumero } from "./schedule.js";

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const TOLERANCIA_HORA_MIN = 2;

function sentidoDe(destino) {
  const n = norm(destino);
  if (n.includes("moreno")) return "m";
  if (n.includes("once")) return "o";
  return null;
}

const esTerminal = (nombre) => ["once", "moreno"].includes(norm(nombre));

// item = { est, r } del barrido del proxy.
// Nunca tira: si algo falla al clasificar, devuelve "normal" para no cortar el
// aviso de cancelación/demora que ya funcionaba.
export function clasificarServicio(item) {
  try {
    return clasificarServicioInterno(item);
  } catch (err) {
    console.error("Error clasificando servicio (local/normal):", err.message);
    return { esLocal: false, tipo: "normal", numero: null, origen: null, cronograma: null, fueraDeCronograma: false, motivos: [], etiqueta: null };
  }
}

function clasificarServicioInterno(item) {
  const d = datosServicio(item);
  const numero = d.s.numero ?? null;
  const sentido = sentidoDe(d.destino);
  const cron = buscarEnCronograma({ numero, sentido, estacionNombre: d.est.nombre, prog: d.prog, tolerancia: TOLERANCIA_HORA_MIN });

  const origenProxyEst = d.origenReal ? buscarEstacion(d.origenReal) : null;
  const origenProxy = origenProxyEst?.name ?? d.origenReal ?? null;
  const proxyLocal = !!origenProxyEst && !esTerminal(origenProxyEst.name);
  const esLocal = proxyLocal || !!cron?.esLocal;

  const motivos = [];
  if (esLocal) {
    if (!cron) {
      motivos.push(`no figura en el cronograma (sale de ${origenProxy ?? "?"}, prog ${hora(d.prog)})`);
    } else {
      if (origenProxyEst && origenProxyEst.id !== cron.origenId) {
        motivos.push(
          cron.porNumero
            ? `el cronograma lo tiene saliendo de ${cron.origenNombre} ${cron.horaOrigen}; el proxy lo muestra saliendo de ${origenProxy}`
            : `a esa hora el cronograma tiene el #${cron.n} saliendo de ${cron.origenNombre} ${cron.horaOrigen}; el proxy lo muestra saliendo de ${origenProxy}`
        );
      }
      if (cron.porNumero && cron.difMin != null && Math.abs(cron.difMin) > TOLERANCIA_HORA_MIN) {
        motivos.push(`horario distinto al cronograma en ${d.est.nombre} (${cron.difMin > 0 ? "+" : ""}${cron.difMin} min respecto de lo previsto)`);
      }
    }
  }

  const origenMostrado = origenProxy ?? cron?.origenNombre ?? "?";
  const etiqueta = esLocal ? `🚉 LOCAL ${origenMostrado} → ${d.destino}` : null;

  return {
    esLocal,
    tipo: esLocal ? "local" : "normal",
    numero,
    origen: origenMostrado,
    cronograma: cron,
    fueraDeCronograma: esLocal && motivos.length > 0,
    motivos,
    etiqueta,
  };
}

// Línea extra para anexar al aviso privado de una cancelación/demora.
export function textoClasificacionPrivada(c) {
  if (!c.esLocal) return null;
  let t = `   ${c.etiqueta}`;
  if (c.cronograma?.esLocal) t += ` (cronograma: ${c.cronograma.origenNombre} ${c.cronograma.horaOrigen})`;
  if (c.fueraDeCronograma) t += `\n   ⚠️ Fuera de cronograma: ${c.motivos.join("; ")}`;
  return t;
}

// Para /locales (solo admin): cronograma de locales de hoy cotejado con lo que
// muestra el proxy ahora, más los locales del proxy fuera de cronograma.
// Ojo: el proxy solo lista las próximas salidas de cada estación, así que los
// locales más lejanos en el día todavía no aparecen ("sin dato").
export async function reporteLocales() {
  const dia = getDayType();
  const nombreDia = dia === "lv" ? "lunes a viernes" : dia === "sab" ? "sábado" : "domingo/feriado";
  const programados = localesConNumero(dia);
  const barrido = await barridoEstructurado({ forzar: true });

  const porNumero = new Map();
  const fuera = new Map();
  for (const item of barrido.todos) {
    const c = clasificarServicio(item);
    if (c.cronograma?.esLocal && !porNumero.has(c.cronograma.n)) porNumero.set(c.cronograma.n, { item, c });
    if (c.fueraDeCronograma) {
      const clave = `${c.numero ?? "s-num"}-${c.origen}`;
      if (!fuera.has(clave)) fuera.set(clave, { item, c });
    }
  }

  const lineas = programados.map((l) => {
    const base = `#${l.n} ${l.estacion} ${l.hora} → ${l.direccion === "moreno" ? "Moreno" : "Once"}`;
    const visto = porNumero.get(l.n);
    if (!visto) return `${base} · sin dato en el proxy`;
    const d = datosServicio(visto.item);
    let estado = d.s.cancelacion ? `❌ cancelado (${textoCancelacion(d.s.cancelacion)})` : d.demora != null && d.demora >= 10 ? `⏰ +${d.demora} min` : `✅ ${d.estado}`;
    if (visto.c.fueraDeCronograma) estado += ` · ⚠️ ${visto.c.motivos.join("; ")}`;
    return `${base} · ${estado}`;
  });

  let texto = `🚉 Locales del cronograma (${nombreDia}): ${programados.length}\n\n${lineas.join("\n")}`;
  if (fuera.size) {
    texto += `\n\n⚠️ Locales del proxy fuera de cronograma:\n` +
      [...fuera.values()].map(({ item, c }) => `• #${c.numero ?? "?"} ${c.etiqueta} · prog ${hora(datosServicio(item).prog)} — ${c.motivos.join("; ")}`).join("\n");
  } else {
    texto += `\n\nNingún local del proxy fuera de cronograma en este momento.`;
  }
  return texto;
}
