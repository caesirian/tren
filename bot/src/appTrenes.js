// src/appTrenes.js
// Consulta EXPERIMENTAL a los datos de la app de Trenes Argentinos (SOFSE) a
// través del proxy comunitario de ariedro (https://github.com/ariedro/api-trenes,
// docs en https://trenes.sofse.apidocs.ar). NO es una API oficial ni pública:
// depende de un servidor de terceros. Por ahora solo se usa para el comando de
// admin /apptrenes, para ver qué datos aparecen (estado por tren, demoras,
// cancelaciones, leyendas) antes de decidir si se integran como fuente del bot.
//
// El proxy reenvía cualquier GET a la API interna de SOFSE, así que
// consultarProxy() sirve también para probar rutas no documentadas
// (por ejemplo, de alertas).

import { getTramoLimitado, tramoIncluye, resumenTramo } from "./servicioLimitado.js";

const BASE = (process.env.TRENES_PROXY_URL || "https://ariedro.dev/api-trenes").replace(/\/$/, "");

export async function consultarProxy(ruta) {
  const path = ruta.startsWith("/") ? ruta : `/${ruta}`;
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20000) });
  const texto = await res.text();
  if (!res.ok) throw new Error(`El proxy respondió ${res.status} ${res.statusText}: ${texto.slice(0, 200)}`);
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export const hora = (iso) =>
  iso ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "--:--";

const corto = (v) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);

// El campo "cancelacion" del proxy a veces es un objeto con datos internos de
// SOFSE (incluye el mail del empleado que la cargó, id de usuario, etc.). Acá
// se saca solo el motivo/descripción legible, sin volcar el objeto crudo ni
// datos de esa persona.
const CAMPOS_MOTIVO = ["motivo", "descripcion", "detalle", "mensaje", "texto", "causa", "leyenda", "observacion"];
export function textoCancelacion(c) {
  if (!c) return null;
  if (typeof c === "string") return c.slice(0, 200);
  for (const campo of CAMPOS_MOTIVO) if (typeof c[campo] === "string" && c[campo].trim()) return c[campo].trim().slice(0, 200);
  return "cancelado (SOFSE no informa un motivo en texto)";
}

function listaEstaciones(data) {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : Array.isArray(data?.estaciones) ? data.estaciones : [];
  // Forma real del proxy: { nombre, id_estacion: "278", id_tramo, incluida_en_ramales: [..], ... }
  const vistos = new Set();
  return arr
    .map((e) => ({ id: e.id_estacion ?? e.id ?? e.idElemento ?? e.idEstacion, nombre: e.nombre ?? e.name ?? "?", crudo: e }))
    .filter((e) => e.id != null && !vistos.has(String(e.id)) && vistos.add(String(e.id)));
}

// Los IDs de estación no cambian: la búsqueda por nombre se cachea 6 h para que cada
// consulta de arribos cueste 1 pedido al proxy en vez de 2 (importa con la vigilancia
// de salidas, que consulta Once y Moreno cada 30 s).
const cacheEstaciones = new Map();
const EDAD_MAX_ESTACIONES_MS = 6 * 60 * 60 * 1000;
async function buscarEstacionesCacheado(nombre) {
  const k = nombre.trim().toLowerCase();
  const hit = cacheEstaciones.get(k);
  if (hit && Date.now() - hit.momento < EDAD_MAX_ESTACIONES_MS) return hit.data;
  const data = await consultarProxy(`/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
  if (listaEstaciones(data).length) cacheEstaciones.set(k, { momento: Date.now(), data });
  return data;
}

// Trae los servicios de Sarmiento de una estación (por nombre).
// Devuelve { servicios: [{ est, r }], revisadas: [...], crudoEstaciones }.
// Cantidad de arribos que se piden por estación. Por defecto 8 (uso puntual); el barrido
// periódico pide más (TRENES_BARRIDO_CANTIDAD, 12 por defecto) para no perder trenes que
// quedaron detenidos o muy demorados y se "corrieron" fuera de los próximos 8.
const cantidadArribos = (cantidad) => {
  const n = Number(cantidad ?? process.env.TRENES_ARRIBOS_CANTIDAD ?? 8);
  return Number.isFinite(n) && n >= 1 && n <= 40 ? Math.floor(n) : 8;
};

export async function serviciosSarmiento(nombre, { cantidad } = {}) {
  const encontradas = await buscarEstacionesCacheado(nombre);
  let candidatas = listaEstaciones(encontradas);
  // Si hay una estación con el nombre exacto, se usa solo esa (evita "Moreno" + "Moreno Norte", etc.).
  const exactas = candidatas.filter((e) => String(e.nombre).trim().toLowerCase() === nombre.trim().toLowerCase());
  if (exactas.length) candidatas = exactas;

  const servicios = [];
  const descartados = []; // servicios de Sarmiento que el filtro Once–Moreno dejó afuera (se siguen vigilando aparte)
  const revisadas = [];
  for (const est of candidatas.slice(0, 4)) {
    revisadas.push(`${est.nombre} (${est.id})`);
    const data = await consultarProxy(`/arribos/estacion/${est.id}?cantidad=${cantidadArribos(cantidad)}`);
    for (const r of data?.results || []) {
      if (!String(r?.servicio?.gerencia?.nombre || "").toLowerCase().includes("sarmiento")) continue;
      // Por ahora el bot informa SOLO lo que ocurre dentro del tramo Moreno–Once
      // (pedido de Coco, 30/9): se descartan acá, en el origen, las formaciones
      // cuyo origen o destino real queda fuera (Merlo–Las Heras, Morón–Luján,
      // etc.). Todo lo que consume este barrido (avisos al grupo, estado
      // automático, tableros, contexto de respuestas) hereda el filtro.
      // Se apaga con TRAMO_SOLO_MORENO_ONCE=false.
      if (tramoSoloMorenoOnce() && servicioFueraDelTramo({ est, r })) {
        descartados.push({ est, r });
        continue;
      }
      servicios.push({ est, r });
    }
  }
  return { servicios, descartados, revisadas, candidatas, crudoEstaciones: encontradas };
}

export function tramoSoloMorenoOnce() {
  return String(process.env.TRAMO_SOLO_MORENO_ONCE ?? "true").trim().toLowerCase() !== "false";
}

// true si el servicio toca algo fuera del tramo Once–Moreno: origen/destino real
// en una estación que no es del ramal (Las Heras, Luján, Mercedes, Lobos…) o un
// ramal/cabecera cuyo nombre lo delata (ej. "Moreno - Mercedes", que por contener
// "Moreno" se confundiría con una estación del tramo). Si el proxy no informa
// nada de esto no se descarta: ante la duda, se informa.
const PALABRAS_FUERA_TRAMO = ["mercedes", "lobos", "las heras", "lujan", "rodriguez", "marcos paz", "suipacha", "navarro", "diesel"];
export function servicioFueraDelTramo({ r }) {
  const s = r?.servicio || {};
  const contienePalabra = (n) => {
    const x = normNombre(n);
    return !!x && PALABRAS_FUERA_TRAMO.some((p) => x.includes(p));
  };
  const estacionAjena = (n) => !!n && indiceEstacionRamal(n) < 0;
  const hasta = s.hasta?.estacion?.nombre;
  const desde = s.desde?.estacion?.nombre;
  return (
    estacionAjena(hasta) || estacionAjena(desde) ||
    contienePalabra(hasta) || contienePalabra(desde) ||
    contienePalabra(s.ramal?.cabeceraFinal?.nombre) || contienePalabra(s.ramal?.cabeceraInicial?.nombre) ||
    contienePalabra(s.ramal?.nombre)
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Servicio limitado (tramo operativo): si hay un tramo vigente (ej. solo
// circulan trenes entre Liniers y Moreno), los servicios que el proxy sigue
// listando como "programados" desde estaciones fuera del tramo NO están
// circulando. Estos helpers los sacan de lo que se muestra.
// ─────────────────────────────────────────────────────────────────────────
function estacionFueraDelTramoVivo(nombre, tramo) {
  const i = indiceEstacionRamal(nombre);
  return !!tramo && i >= 0 && !tramoIncluye(tramo, i);
}

// Descarta servicios cuyo origen real (si se conoce) cae fuera del tramo: nunca
// salieron de ahí. Si el origen no viene en el proxy se conserva (ante la duda, se muestra).
function aplicarTramo(servicios, tramo) {
  if (!tramo) return servicios;
  return servicios.filter((item) => {
    const o = indiceEstacionRamal(datosServicio(item).origenReal);
    return o < 0 || tramoIncluye(tramo, o);
  });
}

// Un tren cuyo destino queda fuera del tramo en realidad termina en el borde del tramo.
function destinoEnTramo(destino, tramo) {
  if (!tramo) return destino;
  const i = indiceEstacionRamal(destino);
  if (i < 0 || tramoIncluye(tramo, i)) return destino;
  return nombreVisibleEstacion(ESTACIONES_BARRIDO[i > tramo.hastaIdx ? tramo.hastaIdx : tramo.desdeIdx]);
}

function textoSinSalidasPorTramo(nombreEstacion, tramo) {
  return `🚧 Servicio limitado: hoy solo circulan trenes entre ${tramo.desde} y ${tramo.hasta}. Desde ${nombreEstacion} no salen trenes por ahora.`;
}

// Nombre exacto del campo de andén sin confirmar todavía (la API no tiene
// documentación oficial — ver README). Se prueban varios nombres posibles,
// tanto en "servicio" como en "arribo"/"salida", y el primero que aparezca
// con datos se usa. Si ninguno aparece, queda null y se omite en el texto.
const CAMPOS_ANDEN = ["anden", "andenSalida", "anden_salida", "plataforma", "via", "nroAnden", "numeroAnden"];
const CAMPOS_ANDEN_SUB = ["nombre", "codigo", "numero", "valor", "value", "id", "label", "descripcion", "texto"];
function buscarAnden(...objetos) {
  for (const obj of objetos) {
    if (!obj) continue;
    for (const campo of CAMPOS_ANDEN) {
      const v = obj[campo];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "object") {
        for (const sub of CAMPOS_ANDEN_SUB) {
          const sv = v[sub];
          if (sv !== undefined && sv !== null && sv !== "") return String(sv);
        }
        console.warn(`buscarAnden: campo "${campo}" es un objeto sin subcampo reconocido: ${JSON.stringify(v).slice(0, 200)}`);
        continue; // no devolver "[object Object]"
      }
      return String(v);
    }
  }
  return null;
}

export function datosServicio({ est, r }) {
  const a = r.arribo || {};
  const s = r.servicio || {};
  const prog = a.llegada?.programada || a.salida?.programada;
  const estim = a.llegada?.estimada || a.salida?.estimada || a.llegada?.real || a.salida?.real;
  const demora = prog && estim ? Math.round((new Date(estim) - new Date(prog)) / 60000) : null;
  const anden = buscarAnden(s, a, a.salida, a.llegada, s.desde);
  // Por simetría con s.hasta.estacion (destino), s.desde.estacion debería ser
  // la estación de ORIGEN real del servicio (sin confirmar contra el proxy
  // real todavía — mismo caso que el andén).
  const origenReal = s.desde?.estacion?.nombre || null;
  return { est, s, prog, estim, demora, anden, origenReal, destino: s.hasta?.estacion?.nombre || s.ramal?.cabeceraFinal?.nombre || s.ramal?.nombre || "?", estado: s.desde?.estado?.nombre || "s/d" };
}

export function lineaServicio(item) {
  const { est, s, prog, estim, demora, anden, destino, estado } = datosServicio(item);
  const { origenReal } = datosServicio(item);
  let l = `• #${s.numero ?? "?"} → ${destino} | ${est.nombre}: prog ${hora(prog)}${estim ? ` / est ${hora(estim)}${demora != null ? ` (${demora >= 0 ? "+" : ""}${demora} min)` : ""}` : ""} | ${estado}${anden ? ` | andén ${anden}` : ""}${origenReal ? ` | origen: ${origenReal}` : ""}`;
  if (s.tipo?.nombre && s.tipo.nombre !== "Normal") l += ` | tipo: ${s.tipo.nombre}`;
  if (s.cancelacion) l += `\n   ❌ Cancelación: ${textoCancelacion(s.cancelacion)}`;
  if (s.leyenda) l += `\n   📢 Leyenda: ${corto(s.leyenda)}`;
  return l;
}

// Reporte de una estación (solo servicios de Sarmiento).
export async function reporteEstacion(nombre) {
  const { servicios, revisadas, candidatas, crudoEstaciones } = await serviciosSarmiento(nombre);
  if (!candidatas.length) {
    return `No pude identificar estaciones para "${nombre}". Respuesta cruda del proxy:\n${corto(JSON.stringify(crudoEstaciones)).slice(0, 1200)}\n\nProbá /apptrenes get /infraestructura/estaciones?nombre=${nombre}`;
  }
  if (!servicios.length) {
    return `No aparecen servicios de Sarmiento en: ${revisadas.join(", ")}.\n(Puede ser que el nombre corresponda a otra línea o que no haya trenes próximos.)`;
  }
  const conCancel = servicios.filter(({ r }) => r?.servicio?.cancelacion).length;
  const conLeyenda = servicios.filter(({ r }) => r?.servicio?.leyenda).length;
  return (
    `🚆 Sarmiento en «${nombre}» — datos de la app de Trenes Argentinos (proxy no oficial)\n` +
    `Servicios: ${servicios.length} · con cancelación: ${conCancel} · con leyenda: ${conLeyenda}\n\n` +
    servicios.slice(0, 10).map(lineaServicio).join("\n") +
    (servicios.length > 10 ? `\n… y ${servicios.length - 10} más` : "")
  );
}

// Barrido de las estaciones principales de Sarmiento: muestra SOLO lo
// anormal (cancelación, leyenda, demora >= 10 min o tipo distinto de Normal).
// Sirve para probar cuándo el proxy trae cancelacion/leyenda con texto real.
// Las 16 estaciones del ramal Once-Moreno completo (antes solo se barrían 7,
// lo que dejaba afuera tramos enteros — ej. Flores, entre Once y Floresta).
export const ESTACIONES_BARRIDO = [
  "Once", "Caballito", "Flores", "Floresta", "Villa Luro", "Liniers", "Ciudadela", "Ramos Mejía",
  "Haedo", "Morón", "Castelar", "Ituzaingó", "Padua", "Merlo", "Paso del Rey", "Moreno",
];

const esAnormal = (item) => {
  const { s, demora } = datosServicio(item);
  return !!(s.cancelacion || s.leyenda || (demora != null && demora >= 10) || (s.tipo?.nombre && s.tipo.nombre !== "Normal"));
};

// Barrido estructurado (con caché corta para no golpear el proxy de un
// tercero cuando llegan varias capturas seguidas).
let cacheBarrido = null;
const EDAD_MAX_CACHE_MS = 2 * 60 * 1000;

export async function barridoEstructurado({ forzar = false } = {}) {
  if (!forzar && cacheBarrido && Date.now() - cacheBarrido.momento < EDAD_MAX_CACHE_MS) return cacheBarrido;
  const cantidad = cantidadArribos(process.env.TRENES_BARRIDO_CANTIDAD ?? 12);
  const resultados = await Promise.allSettled(ESTACIONES_BARRIDO.map((n) => serviciosSarmiento(n, { cantidad })));
  const todos = [];
  const fueraTramo = [];
  const vistos = new Set();
  const vistosFuera = new Set();
  const errores = [];
  resultados.forEach((res, i) => {
    if (res.status === "rejected") {
      errores.push(`${ESTACIONES_BARRIDO[i]}: ${res.reason?.message || res.reason}`);
      return;
    }
    for (const item of res.value.descartados || []) {
      const clave = `${item.r?.servicio?.numero}-${item.est.id}`;
      if (vistosFuera.has(clave)) continue;
      vistosFuera.add(clave);
      fueraTramo.push(item);
    }
    if (!res.value.servicios.length && !(res.value.descartados || []).length) errores.push(`${ESTACIONES_BARRIDO[i]}: sin servicios de Sarmiento (estaciones: ${res.value.revisadas.join(", ") || "ninguna"})`);
    for (const item of res.value.servicios) {
      const clave = `${item.r?.servicio?.numero}-${item.est.id}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      todos.push(item);
    }
  });
  cacheBarrido = { todos, fueraTramo, anormales: todos.filter(esAnormal), errores, momento: Date.now() };
  return cacheBarrido;
}

// Próximas salidas de una CABECERA (Once o Moreno): son los servicios que
// arrancan ahí, ordenados por hora programada. Usa el mismo endpoint que el
// resto (arribos de esa estación) — para una cabecera, el próximo arribo QUE
// LISTA ahí es directamente la próxima salida, porque el servicio nace en
// esa estación.
export async function proximasSalidas(nombreEstacion, cantidad = 8) {
  const { servicios, revisadas, candidatas } = await serviciosSarmiento(nombreEstacion);
  if (!candidatas.length) return { texto: `No encontré la estación "${nombreEstacion}" en el proxy.`, items: [] };
  const tramo = await getTramoLimitado();
  if (estacionFueraDelTramoVivo(candidatas[0]?.nombre || nombreEstacion, tramo)) return { texto: textoSinSalidasPorTramo(candidatas[0]?.nombre || nombreEstacion, tramo), items: [] };
  const ordenados = aplicarTramo([...servicios], tramo).sort((a, b) => (datosServicio(a).prog || "").localeCompare(datosServicio(b).prog || "")).slice(0, cantidad);
  const ahora = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const hayAnden = ordenados.some((i) => datosServicio(i).anden);
  let texto = `🚉 Próximas salidas — ${revisadas.join(", ") || nombreEstacion} (consultado a las ${ahora})\n`;
  texto += ordenados.length ? ordenados.map(lineaServicio).join("\n") : "(sin servicios de Sarmiento saliendo de acá en este momento)";
  if (ordenados.length && !hayAnden) texto += "\n\n(el proxy no trajo el andén para ninguno de estos — puede que este endpoint no lo incluya)";
  return { texto, items: ordenados };
}

// completo=false (default): solo lo anormal, para uso diario.
// completo=true: TODOS los servicios de todas las estaciones, ordenados por
// hora programada — para tener precisión total (ej. durante un incidente
// como un choque, para ver cómo viene llegando cada formación a cada
// estación, no solo dónde hay demora marcada). Es un listado largo: se corta
// en varios mensajes de Telegram (lo hace enviar() en index.js).
// Un mismo tren aparece una vez por cada estación que todavía tiene por
// delante (es la misma demora arrastrada, no un problema nuevo por
// estación). Para el resumen de "solo lo anormal" conviene agruparlo en una
// sola línea por tren, con la estación más próxima (prog más chico, la
// próxima parada) como referencia y la cantidad de estaciones donde se lo ve.
function agruparPorTren(items) {
  const grupos = new Map();
  for (const item of items) {
    const { s } = datosServicio(item);
    const clave = `${s.numero ?? "s-num"}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(item);
  }
  return [...grupos.values()].map((grupo) => {
    grupo.sort((a, b2) => (datosServicio(a).prog || "").localeCompare(datosServicio(b2).prog || ""));
    return grupo[0]; // el de prog más chico: la próxima estación a la que llega
  });
}

function lineaServicioAgrupado(item, cantidadEstaciones) {
  let l = lineaServicio(item);
  if (cantidadEstaciones > 1) l += ` (mismo patrón visto en ${cantidadEstaciones} estaciones del tramo que le queda)`;
  return l;
}

export function textoBarrido(b, { completo = false } = {}) {
  const ahora = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const cancelados = b.anormales.filter((i) => datosServicio(i).s.cancelacion);
  const demorados = b.anormales.filter((i) => !datosServicio(i).s.cancelacion && (datosServicio(i).demora ?? 0) >= 10);
  const trenesCancelados = new Set(cancelados.map((i) => datosServicio(i).s.numero)).size;
  const trenesDemorados = new Set(demorados.map((i) => datosServicio(i).s.numero)).size;

  let texto = `🔎 Barrido Sarmiento — consultado a las ${ahora}\n(${ESTACIONES_BARRIDO.length} estaciones: ${ESTACIONES_BARRIDO.join(", ")})\n`;
  texto += `Servicios revisados: ${b.todos.length} · trenes cancelados: ${trenesCancelados} · trenes con demora 10+ min: ${trenesDemorados}\n`;

  if (completo) {
    const ordenados = [...b.todos].sort((a, b2) => (datosServicio(a).prog || "").localeCompare(datosServicio(b2).prog || ""));
    texto += ordenados.length ? `\n${ordenados.map(lineaServicio).join("\n")}` : "\n(sin servicios de Sarmiento en este momento)";
  } else if (b.anormales.length) {
    const agrupados = agruparPorTren(b.anormales);
    const cantidadPorTren = new Map();
    for (const item of b.anormales) {
      const num = datosServicio(item).s.numero ?? "s-num";
      cantidadPorTren.set(num, (cantidadPorTren.get(num) || 0) + 1);
    }
    texto += `\n${agrupados
      .slice(0, 15)
      .map((item) => lineaServicioAgrupado(item, cantidadPorTren.get(datosServicio(item).s.numero ?? "s-num") || 1))
      .join("\n")}`;
  } else {
    texto += "\nNingún servicio con cancelación, leyenda, demora de 10+ min o tipo especial en este momento.";
  }
  if (b.errores.length) texto += `\n\nAvisos:\n- ${b.errores.join("\n- ")}`;
  return texto;
}

export async function barridoSarmiento({ completo = false } = {}) {
  return textoBarrido(await barridoEstructurado({ forzar: true }), { completo });
}

// Filas "crudas" (número, andén, hora, destino, estado) para armar una
// tabla — esto es la fuente de verdad real, no pasa por ningún modelo.
export async function filasParaTabla(nombreEstacion, cantidad = 8) {
  const { servicios, revisadas, candidatas } = await serviciosSarmiento(nombreEstacion);
  if (!candidatas.length) return { filas: [], revisadas: [], error: `No encontré la estación "${nombreEstacion}" en el proxy.` };

  const tramo = await getTramoLimitado();
  if (estacionFueraDelTramoVivo(candidatas[0]?.nombre || nombreEstacion, tramo)) return { filas: [], revisadas, error: textoSinSalidasPorTramo(candidatas[0]?.nombre || nombreEstacion, tramo) };
  const ordenados = aplicarTramo([...servicios], tramo).sort((a, b) => (datosServicio(a).prog || "").localeCompare(datosServicio(b).prog || "")).slice(0, cantidad);
  const filas = ordenados.map((item) => {
    const { s, prog, estim, anden, destino, estado } = datosServicio(item);
    return {
      numero: s.numero ?? null,
      anden: anden ?? null,
      horaProgramada: hora(prog),
      horaEstimada: estim ? hora(estim) : null,
      destino: destinoEnTramo(destino, tramo),
      estado: s.cancelacion ? "CANCELADO" : estado,
      motivoCancelacion: s.cancelacion ? textoCancelacion(s.cancelacion) : null,
      paradas: paradasHasta(revisadas[0] || nombreEstacion, destinoEnTramo(destino, tramo)),
    };
  });
  return { filas, revisadas, error: null };
}

// ESTACIONES_ORIGEN_NORMAL: de dónde parte un servicio habitualmente. Trenes
// que declaran salir de otra estación (ej. Liniers en vez de Flores para los
// "locales") son un cambio operativo que conviene ver apenas aparece en los
// datos — suele publicarse antes de que el tren realmente salga.
const ESTACIONES_ORIGEN_NORMAL = new Set(["Once", "Moreno", "Flores", "Merlo"]);

export function trenesConOrigenInusual(items) {
  const vistos = new Set();
  const resultado = [];
  for (const item of items) {
    const d = datosServicio(item);
    if (!d.origenReal || ESTACIONES_ORIGEN_NORMAL.has(d.origenReal)) continue;
    const clave = `${d.s.numero}-${d.origenReal}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    resultado.push(item);
  }
  return resultado;
}

// Datos para el tablero estilo cartelera física: próximas salidas de una
// cabecera (Once/Moreno), una por columna, con andén y estado tal como los
// necesita esa UI. cantidad=5 porque el cartel real de Once muestra 5.
export async function columnasCabecera(nombreEstacion, cantidad = 5) {
  const { servicios, candidatas } = await serviciosSarmiento(nombreEstacion);
  if (!candidatas.length) return { estacion: nombreEstacion, columnas: [] };
  const tramo = await getTramoLimitado();
  const limitado = resumenTramo(tramo);
  const nombreCabecera = candidatas[0]?.nombre || nombreEstacion;
  if (estacionFueraDelTramoVivo(nombreCabecera, tramo)) {
    return { estacion: nombreCabecera, columnas: [], servicioLimitado: { ...limitado, sinSalidas: true, textoSinSalidas: textoSinSalidasPorTramo(nombreCabecera, tramo) } };
  }
  const ordenados = aplicarTramo([...servicios], tramo).sort((a, b) => (datosServicio(a).prog || "").localeCompare(datosServicio(b).prog || "")).slice(0, cantidad);
  const columnas = ordenados.map((item) => {
    const d = datosServicio(item);
    return {
      anden: d.anden,
      horaSalida: hora(d.prog),
      destino: destinoEnTramo(d.destino, tramo),
      estado: d.estado,
      cancelado: !!d.s.cancelacion,
      motivoCancelacion: d.s.cancelacion ? textoCancelacion(d.s.cancelacion) : null,
      origen: d.origenReal,
      origenInusual: !!d.origenReal && !ESTACIONES_ORIGEN_NORMAL.has(d.origenReal),
      // Paradas REALES según el destino de ese servicio (si el servicio está
      // limitado y termina en Castelar, no se listan las estaciones de después).
      paradas: paradasHasta(nombreCabecera, destinoEnTramo(d.destino, tramo)),
    };
  });
  return { estacion: nombreCabecera, columnas, servicioLimitado: limitado };
}

// ---------------------------------------------------------------------------
// Mapa esquemático: posición interpolada de cada tren entre estaciones
// ---------------------------------------------------------------------------
// Si el proxy trae GPS real del tren (servicio.location) se usa ese; si no, la posición se
// ESTIMA por tiempo (respaldo): cada tren aparece varias veces en el barrido (una por
// estación que todavía tiene por delante); se ordenan esas apariciones según
// el ORDEN REAL de las 16 estaciones del ramal (no por hora, para no
// depender de que el reloj esté bien), y de ahí sale el sentido. Con eso se
// ubica al tren entre las dos estaciones cuya hora (estimada si hay, si no
// programada) engloba el momento actual. Es una aproximación: si el tren
// viene muy demorado, la posición estimada se corre para el mismo lado.
// ---------------------------------------------------------------------------
// GPS REAL: el proxy trae `servicio.location = { lat, long }` para los trenes que ya partieron
// (null mientras no salieron). Se proyecta sobre el eje del ramal (poligonal que une las 16
// estaciones) para obtener la misma coordenada fraccionaria 0..15 que usa la interpolación por
// horarios. Si no hay GPS, o cae lejos del ramal, se sigue usando la estimación por horarios.
// Las coordenadas de las estaciones son las de STATIONS en index.html (misma fuente).
// ---------------------------------------------------------------------------
export const COORDS_ESTACIONES = [
  [-34.6083, -58.4103], // 0 Once,
  [-34.6187, -58.4417], // 1 Caballito,
  [-34.6273, -58.4613], // 2 Flores,
  [-34.6307, -58.4807], // 3 Floresta,
  [-34.6313, -58.5003], // 4 Villa Luro,
  [-34.6367, -58.5213], // 5 Liniers,
  [-34.6397, -58.5380], // 6 Ciudadela,
  [-34.6433, -58.5617], // 7 Ramos Mejía,
  [-34.6448, -58.5830], // 8 Haedo,
  [-34.6487, -58.6183], // 9 Morón,
  [-34.6513, -58.6487], // 10 Castelar,
  [-34.6583, -58.6717], // 11 Ituzaingó,
  [-34.6647, -58.7030], // 12 San A. de Padua,
  [-34.6700, -58.7283], // 13 Merlo,
  [-34.6637, -58.7567], // 14 Paso del Rey,
  [-34.6503, -58.7917], // 15 Moreno
];
const MAX_DIST_EJE_M = 1500; // más lejos que esto del eje = GPS dudoso (cochera, otro ramal, dato viejo)

export function gpsValido(loc) {
  if (!loc) return null;
  const lat = Number(loc.lat);
  const long = Number(loc.long ?? loc.lng ?? loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(long)) return null;
  if (lat === 0 && long === 0) return null;
  if (lat < -35.2 || lat > -34.2 || long < -59.2 || long > -58.0) return null; // fuera del área metropolitana oeste
  return { lat, long };
}

// Devuelve { posicion: 0..15 (fraccionario), distM } del punto proyectado sobre el ramal.
export function proyectarEnRamal(lat, long) {
  const LAT0 = -34.64;
  const kx = 111320 * Math.cos((LAT0 * Math.PI) / 180);
  const ky = 110540;
  const px = long * kx, py = lat * ky;
  let mejor = null;
  for (let i = 0; i < COORDS_ESTACIONES.length - 1; i++) {
    const ax = COORDS_ESTACIONES[i][1] * kx, ay = COORDS_ESTACIONES[i][0] * ky;
    const bx = COORDS_ESTACIONES[i + 1][1] * kx, by = COORDS_ESTACIONES[i + 1][0] * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const distM = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!mejor || distM < mejor.distM) mejor = { posicion: i + t, distM };
  }
  return mejor;
}

export function posicionesEnVivo(items, ahora = new Date()) {
  const orden = new Map(ESTACIONES_BARRIDO.map((n, i) => [n, i]));
  const porTren = new Map();
  for (const item of items) {
    const d = datosServicio(item);
    const idx = orden.get(item.est.nombre);
    if (idx == null) continue; // estación fuera de las 16 conocidas (no debería pasar)
    const num = d.s.numero ?? `s-${Math.random()}`;
    if (!porTren.has(num)) porTren.set(num, { numero: d.s.numero ?? null, destino: d.destino, cancelado: !!d.s.cancelacion, origen: d.origenReal, cruces: [] });
    porTren.get(num).cruces.push({ idx, nombre: item.est.nombre, prog: d.prog, tiempo: d.estim || d.prog, demora: d.demora });
    if (!porTren.get(num).gps) porTren.get(num).gps = gpsValido(d.s.location);
  }

  const resultado = [];
  for (const tren of porTren.values()) {
    const conTiempo = tren.cruces.filter((c) => c.tiempo);
    if (conTiempo.length < 1) continue;
    // El orden que importa para interpolar es el CRONOLÓGICO (por hora), no
    // el de índice de estación: en sentido Moreno→Once el índice de
    // estación va bajando a medida que pasa el tiempo.
    const porHora = [...conTiempo].sort((a, b) => new Date(a.tiempo) - new Date(b.tiempo));
    // Con 2+ cruces el sentido sale del orden cronológico; con uno solo se deduce del destino.
    const idxDestino = orden.get(tren.destino);
    const sentido = porHora.length > 1
      ? (porHora[0].idx > porHora[porHora.length - 1].idx ? "Moreno-Once" : "Once-Moreno")
      : idxDestino != null && idxDestino !== porHora[0].idx
        ? (idxDestino < porHora[0].idx ? "Moreno-Once" : "Once-Moreno")
        : /once/i.test(tren.destino || "") ? "Moreno-Once" : "Once-Moreno";

    // Si el índice de estación no es monótono a lo largo del tiempo (no
    // sube ni baja siempre), el dato es inconsistente — se descarta ese tren
    // para el mapa en vez de mostrar una posición engañosa.
    const diffs = porHora.slice(1).map((c, i) => c.idx - porHora[i].idx);
    const consistente = diffs.every((d) => d >= 0) || diffs.every((d) => d <= 0);
    if (!consistente) continue;

    const t = ahora.getTime();
    let posEstimada;
    if (t <= new Date(porHora[0].tiempo).getTime()) {
      posEstimada = porHora[0].idx; // todavía no llega a la primera estación que tenemos de él
    } else if (t >= new Date(porHora[porHora.length - 1].tiempo).getTime()) {
      posEstimada = porHora[porHora.length - 1].idx; // ya pasó la última que tenemos (puede estar por llegar a destino)
    } else {
      let i = 0;
      while (i < porHora.length - 1 && !(t >= new Date(porHora[i].tiempo).getTime() && t <= new Date(porHora[i + 1].tiempo).getTime())) i++;
      const a = porHora[i];
      const b = porHora[i + 1];
      const total = new Date(b.tiempo).getTime() - new Date(a.tiempo).getTime();
      const frac = total > 0 ? (t - new Date(a.tiempo).getTime()) / total : 0;
      posEstimada = a.idx + (b.idx - a.idx) * frac;
    }

    const proy = tren.gps ? proyectarEnRamal(tren.gps.lat, tren.gps.long) : null;
    const gpsOk = !!proy && proy.distM <= MAX_DIST_EJE_M;
    resultado.push({
      numero: tren.numero,
      destino: tren.destino,
      cancelado: tren.cancelado,
      origenInusual: !!tren.origen && !ESTACIONES_ORIGEN_NORMAL.has(tren.origen),
      sentido,
      posicion: gpsOk ? proy.posicion : posEstimada, // 0..15, fraccionario: GPS real si es usable, si no la estimada
      posicionEstimada: posEstimada,
      fuente: gpsOk ? "gps" : "estimada",
      gps: tren.gps ? { lat: tren.gps.lat, long: tren.gps.long, posicion: proy.posicion, distEjeM: Math.round(proy.distM), usable: gpsOk } : null,
      demoraMax: Math.max(0, ...porHora.map((c) => c.demora ?? 0)),
      proximaEstacion: porHora[0].nombre,
      // Horario PROGRAMADO en cada estación que todavía tiene por delante. La web lo usa para
      // reconocer "su" tren a partir del horario del cronograma (ver "¿Dónde está mi tren?").
      paradas: porHora.filter((c) => c.prog).map((c) => ({ idx: c.idx, prog: c.prog })),
    });
  }
  return resultado;
}


// ─────────────────────────────────────────────────────────────────────────
// Recorrido REAL de los servicios (servicio limitado / recorrido acortado).
// Cada servicio del proxy trae su destino real (hasta) y su origen real
// (desde). Con eso sabemos hasta dónde llega cada tren HOY, en vez de
// asumir siempre el recorrido completo Once–Moreno del cronograma.
// ─────────────────────────────────────────────────────────────────────────

function normNombre(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Índice (0 = Once … 15 = Moreno) de una estación del ramal, tolerando
// variantes de nombre ("S.A. de Padua", "San Antonio de Padua", acentos).
export function indiceEstacionRamal(nombre) {
  const n = normNombre(nombre);
  if (!n) return -1;
  if (n.includes("padua")) return ESTACIONES_BARRIDO.indexOf("Padua");
  const exacto = ESTACIONES_BARRIDO.findIndex((e) => normNombre(e) === n);
  if (exacto >= 0) return exacto;
  if (n.length < 4) return -1;
  return ESTACIONES_BARRIDO.findIndex((e) => n.includes(normNombre(e)) || normNombre(e).includes(n));
}

// Paradas entre el origen (excluido) y el destino (incluido), en el orden del
// recorrido. Si el destino no se reconoce: desde una cabecera se asume el
// recorrido completo hacia la otra; desde una intermedia no se inventa nada.
export function paradasHasta(origenNombre, destinoNombre) {
  const ultimo = ESTACIONES_BARRIDO.length - 1;
  const io = indiceEstacionRamal(origenNombre);
  if (io < 0) return ESTACIONES_BARRIDO.slice();
  const idd = indiceEstacionRamal(destinoNombre);
  let fin;
  if (idd >= 0 && idd !== io) fin = idd;
  else if (io === 0) fin = ultimo;
  else if (io === ultimo) fin = 0;
  else return [];
  const paso = fin > io ? 1 : -1;
  const res = [];
  for (let i = io + paso; paso > 0 ? i <= fin : i >= fin; i += paso) res.push(ESTACIONES_BARRIDO[i]);
  return res;
}

function nombreVisibleEstacion(n) {
  return n === "Padua" ? "San Antonio de Padua" : n;
}

// Resumen de hasta dónde llegan hoy los trenes (según el barrido en vivo,
// que se cachea, así que llamarlo seguido no golpea el proxy).
export async function recorridoVivo() {
  const b = await barridoEstructurado();
  const ultimo = ESTACIONES_BARRIDO.length - 1;
  const trenes = new Map();
  for (const item of b.todos) {
    const d = datosServicio(item);
    const num = d.s.numero;
    if (num == null || d.s.cancelacion) continue;
    const idDest = indiceEstacionRamal(d.destino);
    const idEst = indiceEstacionRamal(item.est.nombre);
    if (idDest < 0 || idEst < 0 || idDest === idEst) continue;
    if (trenes.has(num)) continue;
    const idOrig = d.origenReal ? indiceEstacionRamal(d.origenReal) : -1;
    trenes.set(num, { numero: num, sentido: idDest > idEst ? "moreno" : "once", destinoIdx: idDest, origenIdx: idOrig });
  }
  const lista = [...trenes.values()];
  const contar = (arr, campo) => {
    const c = {};
    for (const t of arr) {
      const n = nombreVisibleEstacion(ESTACIONES_BARRIDO[t[campo]]);
      c[n] = (c[n] || 0) + 1;
    }
    return c;
  };

  const haciaMoreno = lista.filter((t) => t.sentido === "moreno");
  const haciaOnce = lista.filter((t) => t.sentido === "once");

  const resMoreno = haciaMoreno.length
    ? (() => {
        const alcanceIdx = Math.max(...haciaMoreno.map((t) => t.destinoIdx));
        const llegan = haciaMoreno.filter((t) => t.destinoIdx === ultimo).length;
        return { total: haciaMoreno.length, alcanceIdx, alcance: ESTACIONES_BARRIDO[alcanceIdx], limitado: llegan === 0, mixto: llegan > 0 && llegan < haciaMoreno.length, destinos: contar(haciaMoreno, "destinoIdx") };
      })()
    : null;

  // Hacia Once, el recorte se ve en el ORIGEN (dónde arrancan los trenes).
  const conOrigen = haciaOnce.filter((t) => t.origenIdx >= 0);
  const resOnce = haciaOnce.length && conOrigen.length === haciaOnce.length
    ? (() => {
        const alcanceIdx = Math.max(...conOrigen.map((t) => t.origenIdx));
        const arrancanEnMoreno = conOrigen.filter((t) => t.origenIdx === ultimo).length;
        return { total: haciaOnce.length, alcanceIdx, alcance: ESTACIONES_BARRIDO[alcanceIdx], limitado: arrancanEnMoreno === 0, mixto: arrancanEnMoreno > 0 && arrancanEnMoreno < haciaOnce.length, origenes: contar(conOrigen, "origenIdx") };
      })()
    : null;

  return { disponible: lista.length > 0, haciaMoreno: resMoreno, haciaOnce: resOnce, momento: b.momento };
}

// ¿La estación queda FUERA del recorrido en ese sentido por servicio limitado?
export function estacionFueraDeRecorrido(recorrido, nombreEstacion, sentido) {
  if (!recorrido?.disponible) return false;
  const idx = indiceEstacionRamal(nombreEstacion);
  if (idx < 0) return false;
  const r = sentido === "moreno" ? recorrido.haciaMoreno : recorrido.haciaOnce;
  return !!(r && r.limitado && idx > r.alcanceIdx);
}

// Frase lista para el contexto del bot / mensajes: qué recorrido tienen hoy los trenes.
export function textoRecorrido(recorrido) {
  if (!recorrido?.disponible) return null;
  const partes = [];
  const m = recorrido.haciaMoreno;
  if (m?.limitado) {
    partes.push(`SERVICIO LIMITADO hacia Moreno: los trenes que figuran en el sistema en este momento NO llegan a Moreno; como máximo llegan hasta ${nombreVisibleEstacion(m.alcance)} (destinos: ${Object.entries(m.destinos).map(([k, v]) => `${k} x${v}`).join(", ")}). Las estaciones posteriores a ${nombreVisibleEstacion(m.alcance)} NO tienen tren hacia Moreno ahora.`);
  } else if (m?.mixto) {
    partes.push(`Recorridos mezclados hacia Moreno: algunos trenes llegan a Moreno y otros terminan antes (destinos: ${Object.entries(m.destinos).map(([k, v]) => `${k} x${v}`).join(", ")}). Cada tren llega solo hasta su destino.`);
  }
  const o = recorrido.haciaOnce;
  if (o?.limitado) {
    partes.push(`SERVICIO LIMITADO hacia Once: los trenes que figuran en el sistema arrancan como máximo desde ${nombreVisibleEstacion(o.alcance)} (no hay trenes que salgan de estaciones posteriores hacia Once ahora).`);
  } else if (o?.mixto) {
    partes.push(`Recorridos mezclados hacia Once: algunos trenes salen de Moreno y otros de estaciones anteriores (orígenes: ${Object.entries(o.origenes).map(([k, v]) => `${k} x${v}`).join(", ")}).`);
  }
  return partes.length ? partes.join("\n") : null;
}

// Próximos trenes que REALMENTE llegan a una estación (datos en vivo, con su
// destino real), por sentido. null si la estación no se reconoce.
export async function arribosVivosEstacion(nombreEstacion) {
  const idx = indiceEstacionRamal(nombreEstacion);
  if (idx < 0) return null;
  const b = await barridoEstructurado();
  const ahora = Date.now();
  const tramo = await getTramoLimitado();
  const out = { haciaMoreno: [], haciaOnce: [] };
  if (tramo) {
    out.servicioLimitado = resumenTramo(tramo);
    if (!tramoIncluye(tramo, idx)) { out.fueraDeTramo = true; return out; }
  }
  const visibles = aplicarTramo(b.todos, tramo);
  for (const item of visibles) {
    if (indiceEstacionRamal(item.est.nombre) !== idx) continue;
    const d = datosServicio(item);
    if (d.s.cancelacion) continue;
    const idDest = indiceEstacionRamal(destinoEnTramo(d.destino, tramo));
    if (idDest < 0 || idDest === idx) continue;
    const t = d.estim || d.prog;
    if (!t) continue;
    const min = Math.round((new Date(t) - ahora) / 60000);
    if (min < -1) continue;
    (idDest > idx ? out.haciaMoreno : out.haciaOnce).push({
      numero: d.s.numero ?? null,
      destino: nombreVisibleEstacion(ESTACIONES_BARRIDO[idDest]),
      hora: hora(t),
      enMinutos: Math.max(0, min),
    });
  }
  out.haciaMoreno.sort((a, c) => a.enMinutos - c.enMinutos);
  out.haciaOnce.sort((a, c) => a.enMinutos - c.enMinutos);
  return out;
}

// Detección automática de servicio limitado desde el proxy: si los trenes que
// figuran hoy no arrancan en Once ni llegan a Once (o no arrancan/llegan a
// Moreno), el servicio está recortado en esa punta. Devuelve el tramo
// observado { desdeIdx, hastaIdx } o null si se ve el recorrido completo o si
// hay muy pocos trenes para concluir algo (ej. de madrugada o a la noche, donde
// el recorte sería un falso positivo).
export async function detectarTramoProxy({ minimoPorSentido = 3 } = {}) {
  const b = await barridoEstructurado();
  const ultimo = ESTACIONES_BARRIDO.length - 1;
  const vistos = new Set();
  const haciaMoreno = [];
  const haciaOnce = [];
  for (const item of b.todos) {
    const d = datosServicio(item);
    const num = d.s.numero;
    if (num == null || d.s.cancelacion || vistos.has(num)) continue;
    const idDest = indiceEstacionRamal(d.destino);
    const idEst = indiceEstacionRamal(item.est.nombre);
    const idOrig = d.origenReal ? indiceEstacionRamal(d.origenReal) : -1;
    if (idDest < 0 || idEst < 0 || idOrig < 0 || idDest === idEst) continue;
    vistos.add(num);
    (idDest > idEst ? haciaMoreno : haciaOnce).push({ idOrig, idDest });
  }
  if (haciaMoreno.length < minimoPorSentido || haciaOnce.length < minimoPorSentido) return null;
  const desdeIdx = Math.min(Math.min(...haciaMoreno.map((t) => t.idOrig)), Math.min(...haciaOnce.map((t) => t.idDest)));
  const hastaIdx = Math.max(Math.max(...haciaMoreno.map((t) => t.idDest)), Math.max(...haciaOnce.map((t) => t.idOrig)));
  if (desdeIdx <= 0 && hastaIdx >= ultimo) return null;
  if (hastaIdx - desdeIdx < 2) return null;
  return { desdeIdx, hastaIdx, trenes: haciaMoreno.length + haciaOnce.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Sondeo de la API: qué rutas responden y qué campos trae cada servicio.
// La API de SOFSE no tiene documentación oficial y el bot hoy usa UNA sola ruta
// (arribos por estación). Esto prueba rutas candidatas (los nombres son suposiciones:
// lo que importa es cuáles devuelven 200) y lista TODOS los campos que trae un
// servicio, para detectar datos útiles que hoy se ignoran (alertas, posición, estado,
// formación, etc.). Comando admin: /apptrenes sondear. También deja todo en el log.
// ─────────────────────────────────────────────────────────────────────────
function tipoValor(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return `{${Object.keys(v).slice(0, 8).join(",")}${Object.keys(v).length > 8 ? ",…" : ""}}`;
  const s = String(v);
  return `${typeof v}:${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
}

// Une las claves de los primeros servicios del barrido: { "servicio.location": "{lat,long}", … }
export function camposDelProxy(items, max = 40) {
  const campos = new Map();
  for (const { r } of items.slice(0, max)) {
    for (const [grupo, obj] of [["raíz", r], ["servicio", r?.servicio], ["arribo", r?.arribo]]) {
      if (!obj || typeof obj !== "object") continue;
      for (const [k, v] of Object.entries(obj)) {
        const clave = `${grupo}.${k}`;
        // Se prefiere un ejemplo con valor real (no null) si aparece en algún servicio.
        if (!campos.has(clave) || (campos.get(clave) === "null" && v !== null)) campos.set(clave, tipoValor(v));
      }
    }
  }
  return Object.fromEntries([...campos.entries()].sort());
}

const RUTAS_CANDIDATAS = [
  "/infraestructura/estaciones?nombre=Merlo",
  "/infraestructura/ramales",
  "/infraestructura/gerencias",
  "/infraestructura/lineas",
  "/infraestructura/tramos",
  "/infraestructura/novedades",
  "/alertas",
  "/novedades",
  "/noticias",
  "/avisos",
  "/comunicados",
  "/estado",
  "/estados",
  "/servicios",
  "/formaciones",
  "/operaciones",
  "/gtfs",
];

export async function sondearEndpoints() {
  const lineas = [];
  const log = (l) => { lineas.push(l); console.log(`Sondeo proxy: ${l}`); };

  // 1) Campos que trae hoy un servicio (lo que el bot podría usar y quizá ignora).
  let barrido = null;
  try {
    barrido = await barridoEstructurado({ forzar: true });
    const campos = camposDelProxy(barrido.todos);
    log(`servicios en el barrido: ${barrido.todos.length} (fuera del tramo: ${barrido.fueraTramo?.length ?? 0}) · errores: ${barrido.errores.length}`);
    for (const [k, v] of Object.entries(campos)) log(`campo ${k} = ${v}`);
  } catch (err) {
    log(`no pude hacer el barrido: ${err.message}`);
  }

  // 2) Rutas candidatas (+ las que se arman con IDs reales del primer servicio).
  const ejemplo = barrido?.todos?.[0];
  const s = ejemplo?.r?.servicio || {};
  const dinamicas = [];
  if (s.numero != null) dinamicas.push(`/arribos/servicio/${s.numero}`, `/servicios/${s.numero}`, `/formaciones/${s.numero}`);
  if (s.id != null) dinamicas.push(`/arribos/servicio/${s.id}`, `/servicios/${s.id}`);
  if (s.ramal?.id != null) dinamicas.push(`/infraestructura/ramales/${s.ramal.id}`, `/arribos/ramal/${s.ramal.id}`, `/formaciones/ramal/${s.ramal.id}`);
  if (s.gerencia?.id != null) dinamicas.push(`/infraestructura/gerencias/${s.gerencia.id}`);
  if (ejemplo?.est?.id != null) dinamicas.push(`/infraestructura/estaciones/${ejemplo.est.id}`, `/arribos/estacion/${ejemplo.est.id}?cantidad=1`);

  for (const ruta of [...RUTAS_CANDIDATAS, ...dinamicas]) {
    try {
      const res = await fetch(`${BASE}${ruta}`, { signal: AbortSignal.timeout(15000) });
      const texto = await res.text();
      let resumen = "";
      if (res.ok) {
        try {
          const j = JSON.parse(texto);
          resumen = Array.isArray(j) ? `array(${j.length})` : `{${Object.keys(j).slice(0, 8).join(",")}}`;
        } catch {
          resumen = "no JSON";
        }
      }
      log(`${res.ok ? "✅" : "✖"} ${res.status} ${ruta} · ${texto.length} caracteres ${resumen}`);
    } catch (err) {
      log(`✖ error ${ruta} · ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 250)); // sin saturar al proxy de terceros
  }
  return lineas;
}
