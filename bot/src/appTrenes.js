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

const hora = (iso) =>
  iso ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "--:--";

const corto = (v) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);

function listaEstaciones(data) {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : Array.isArray(data?.estaciones) ? data.estaciones : [];
  // Forma real del proxy: { nombre, id_estacion: "278", id_tramo, incluida_en_ramales: [..], ... }
  const vistos = new Set();
  return arr
    .map((e) => ({ id: e.id_estacion ?? e.id ?? e.idElemento ?? e.idEstacion, nombre: e.nombre ?? e.name ?? "?", crudo: e }))
    .filter((e) => e.id != null && !vistos.has(String(e.id)) && vistos.add(String(e.id)));
}

// Devuelve { texto } con el reporte de una estación (solo servicios de Sarmiento).
export async function reporteEstacion(nombre) {
  const encontradas = await consultarProxy(`/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
  let candidatas = listaEstaciones(encontradas);
  // Si hay una estación con el nombre exacto, se usa solo esa (evita "Moreno" + "Moreno Norte", etc.).
  const exactas = candidatas.filter((e) => String(e.nombre).trim().toLowerCase() === nombre.trim().toLowerCase());
  if (exactas.length) candidatas = exactas;
  if (!candidatas.length) {
    return `No pude identificar estaciones para "${nombre}". Respuesta cruda del proxy:\n${corto(JSON.stringify(encontradas)).slice(0, 1200)}\n\nProbá /apptrenes get /infraestructura/estaciones?nombre=${nombre}`;
  }

  const servicios = [];
  const revisadas = [];
  for (const est of candidatas.slice(0, 4)) {
    revisadas.push(`${est.nombre} (${est.id})`);
    const data = await consultarProxy(`/arribos/estacion/${est.id}?cantidad=8`);
    for (const r of data?.results || []) {
      if (String(r?.servicio?.gerencia?.nombre || "").toLowerCase().includes("sarmiento")) servicios.push({ est, r });
    }
  }

  if (!servicios.length) {
    return `No aparecen servicios de Sarmiento en: ${revisadas.join(", ")}.\n(Puede ser que el nombre corresponda a otra línea o que no haya trenes próximos.)`;
  }

  const lineas = servicios.slice(0, 10).map(({ est, r }) => {
    const a = r.arribo || {};
    const s = r.servicio || {};
    const prog = a.llegada?.programada || a.salida?.programada;
    const estim = a.llegada?.estimada || a.salida?.estimada || a.llegada?.real || a.salida?.real;
    const demora = prog && estim ? Math.round((new Date(estim) - new Date(prog)) / 60000) : null;
    const destino = s.hasta?.estacion?.nombre || s.ramal?.cabeceraFinal?.nombre || s.ramal?.nombre || "?";
    const estado = s.desde?.estado?.nombre || "s/d";
    let l = `• #${s.numero ?? "?"} → ${destino} | ${est.nombre}: prog ${hora(prog)}${estim ? ` / est ${hora(estim)}${demora != null ? ` (${demora >= 0 ? "+" : ""}${demora} min)` : ""}` : ""} | ${estado}`;
    if (s.tipo?.nombre && s.tipo.nombre !== "Normal") l += ` | tipo: ${s.tipo.nombre}`;
    if (s.cancelacion) l += `\n   ❌ Cancelación: ${corto(s.cancelacion)}`;
    if (s.leyenda) l += `\n   📢 Leyenda: ${corto(s.leyenda)}`;
    return l;
  });

  const conCancel = servicios.filter(({ r }) => r?.servicio?.cancelacion).length;
  const conLeyenda = servicios.filter(({ r }) => r?.servicio?.leyenda).length;
  return (
    `🚆 Sarmiento en «${nombre}» — datos de la app de Trenes Argentinos (proxy no oficial)\n` +
    `Servicios: ${servicios.length} · con cancelación: ${conCancel} · con leyenda: ${conLeyenda}\n\n` +
    lineas.join("\n") +
    (servicios.length > 10 ? `\n… y ${servicios.length - 10} más` : "")
  );
}
