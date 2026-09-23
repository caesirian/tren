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

// Trae los servicios de Sarmiento de una estación (por nombre).
// Devuelve { servicios: [{ est, r }], revisadas: [...], crudoEstaciones }.
export async function serviciosSarmiento(nombre) {
  const encontradas = await consultarProxy(`/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
  let candidatas = listaEstaciones(encontradas);
  // Si hay una estación con el nombre exacto, se usa solo esa (evita "Moreno" + "Moreno Norte", etc.).
  const exactas = candidatas.filter((e) => String(e.nombre).trim().toLowerCase() === nombre.trim().toLowerCase());
  if (exactas.length) candidatas = exactas;

  const servicios = [];
  const revisadas = [];
  for (const est of candidatas.slice(0, 4)) {
    revisadas.push(`${est.nombre} (${est.id})`);
    const data = await consultarProxy(`/arribos/estacion/${est.id}?cantidad=8`);
    for (const r of data?.results || []) {
      if (String(r?.servicio?.gerencia?.nombre || "").toLowerCase().includes("sarmiento")) servicios.push({ est, r });
    }
  }
  return { servicios, revisadas, candidatas, crudoEstaciones: encontradas };
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
const ESTACIONES_BARRIDO = [
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
  const resultados = await Promise.allSettled(ESTACIONES_BARRIDO.map((n) => serviciosSarmiento(n)));
  const todos = [];
  const vistos = new Set();
  const errores = [];
  resultados.forEach((res, i) => {
    if (res.status === "rejected") {
      errores.push(`${ESTACIONES_BARRIDO[i]}: ${res.reason?.message || res.reason}`);
      return;
    }
    if (!res.value.servicios.length) errores.push(`${ESTACIONES_BARRIDO[i]}: sin servicios de Sarmiento (estaciones: ${res.value.revisadas.join(", ") || "ninguna"})`);
    for (const item of res.value.servicios) {
      const clave = `${item.r?.servicio?.numero}-${item.est.id}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      todos.push(item);
    }
  });
  cacheBarrido = { todos, anormales: todos.filter(esAnormal), errores, momento: Date.now() };
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
  const ordenados = [...servicios].sort((a, b) => (datosServicio(a).prog || "").localeCompare(datosServicio(b).prog || "")).slice(0, cantidad);
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

  const ordenados = [...servicios].sort((a, b) => (datosServicio(a).prog || "").localeCompare(datosServicio(b).prog || "")).slice(0, cantidad);
  const filas = ordenados.map((item) => {
    const { s, prog, estim, anden, destino, estado } = datosServicio(item);
    return {
      numero: s.numero ?? null,
      anden: anden ?? null,
      horaProgramada: hora(prog),
      horaEstimada: estim ? hora(estim) : null,
      destino,
      estado: s.cancelacion ? "CANCELADO" : estado,
      motivoCancelacion: s.cancelacion ? textoCancelacion(s.cancelacion) : null,
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
