// src/alternativas.js
// Alternativas de transporte durante cortes: el bot SOLO habla de colectivos
// con lo que esté cargado y verificado en data/alternativas.json (editable
// sin tocar código). Reemplaza la búsqueda web en vivo de colectivos, que
// inventaba recorridos (ej. el 136 "hasta Once", cuando termina en Primera Junta).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUTA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "alternativas.json");

export const RE_CONSULTA_COLECTIVO =
  /\bcolectivos?\b|\bbondis?\b|\bl[ií]nea\s*\d+\b|\bmicros?\b|\balternativas?\b|\b(?:el|al|del)\s+\d{3}\b/i;

function cargar() {
  // Se relee en cada consulta: editás el JSON, lo subís y aplica sin reiniciar.
  try {
    const data = JSON.parse(fs.readFileSync(RUTA, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("[alternativas] no se pudo leer data/alternativas.json:", err.message);
    return [];
  }
}

// Solo entradas verificadas y dentro de su rango de fechas.
export function alternativasActivas(ahora = new Date()) {
  return cargar().filter((c) => {
    if (c.verificado !== true || !Array.isArray(c.alternativas) || !c.alternativas.length) return false;
    const desde = new Date(c.desde);
    const hasta = new Date(c.hasta);
    return !Number.isNaN(+desde) && !Number.isNaN(+hasta) && desde <= ahora && ahora <= hasta;
  });
}

// Bloque para el contexto de Gemini. `sentinel` es SIN_RESPUESTA_CONCRETA:
// con eso, el flujo existente se queda callado al aire y responde "sin dato"
// cuando le hablan directo.
export function contextoAlternativas(ahora = new Date(), sentinel = "SIN_RESPUESTA_CONCRETA") {
  const activas = alternativasActivas(ahora);

  if (!activas.length) {
    return (
      `\n== COLECTIVOS / ALTERNATIVAS ==\n` +
      `No hay información verificada de colectivos ni alternativas cargada para este momento. ` +
      `NO menciones líneas de colectivo, recorridos, paradas ni combinaciones de memoria, ni afirmes hasta dónde llega ninguna línea. ` +
      `Respondé solo ${sentinel}.`
    );
  }

  const lista = activas
    .map((c) => `CORTE: ${c.tramo}\n` + c.alternativas.map((a) => `- ${a}`).join("\n"))
    .join("\n\n");

  return (
    `\n== ALTERNATIVAS VERIFICADAS (cargadas a mano, vigentes ahora) ==\n${lista}\n` +
    `Para consultas de colectivos/alternativas usá SOLO esta lista. No agregues líneas, recorridos ni paradas que no figuren acá, ` +
    `ni afirmes hasta dónde llega una línea si la lista no lo dice (el listado "colectivos en la zona" de una estación solo indica que pasan cerca, no su recorrido). ` +
    `Si lo que preguntan no está cubierto por esta lista, respondé solo ${sentinel}.`
  );
}
