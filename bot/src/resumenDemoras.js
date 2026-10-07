// src/resumenDemoras.js
// Aviso de demoras para el grupo en forma de RESUMEN (pedido del admin, oct 2026):
// el barrido del proxy trae la misma formación varias veces (una por estación),
// así que en vez de listar trenes se deduce una conclusión: cuántas formaciones
// distintas están demoradas, en qué sentido, cuánto y desde cuándo. Lógica pura
// (sin red), para poder probarla con datos simulados.
//
// Cada registro: { numero, destino, demora (min), prog (ISO), estacion, esLocal }.

const norm = (t) => (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function sentidoDe(destino) {
  const n = norm(destino);
  if (n.includes("moreno")) return "Moreno";
  if (n.includes("once")) return "Once";
  return destino && destino !== "?" ? destino : "sentido sin identificar";
}

const hora = (ms) =>
  new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));

// Misma formación = mismo número de servicio (aparece una vez por estación del
// barrido). Sin número no se puede asegurar, así que cuenta como una aparte.
function formacionesUnicas(registros) {
  const porClave = new Map();
  for (const r of registros) {
    const clave = r.numero != null ? `n${r.numero}` : `s${r.destino}-${r.estacion}-${r.prog}`;
    const previo = porClave.get(clave);
    if (!previo) {
      porClave.set(clave, { ...r, sentido: sentidoDe(r.destino), estaciones: new Set([r.estacion]) });
    } else {
      previo.estaciones.add(r.estacion);
      if ((r.demora ?? 0) > (previo.demora ?? 0)) { previo.demora = r.demora; previo.estacion = r.estacion; }
      if (r.prog && (!previo.prog || new Date(r.prog) < new Date(previo.prog))) previo.prog = r.prog;
    }
  }
  return [...porClave.values()];
}

const cuantas = (n) => (n >= 4 ? "muchas" : "algunas");
const plural = (n, uno, varios) => (n === 1 ? uno : varios);

function textoVentana(formaciones, ahoraMs) {
  const progs = formaciones.map((f) => (f.prog ? new Date(f.prog).getTime() : null)).filter((x) => x != null && !Number.isNaN(x));
  if (!progs.length) return "";
  const edadMin = (ahoraMs - Math.min(...progs)) / 60000;
  if (edadMin <= 75) return " en la última hora";
  return ` desde las ${hora(Math.min(...progs))}`;
}

function rangoDemora(fs) {
  const ds = fs.map((f) => f.demora ?? 0);
  const max = Math.max(...ds);
  const min = Math.min(...ds);
  return fs.length > 1 && max - min >= 5 ? `entre +${min} y +${max} min` : `hasta +${max} min`;
}

// Devuelve el texto del aviso (una sola oración) o null si no hay demoras.
export function resumirDemoras(registros, ahoraMs = Date.now()) {
  const fs = formacionesUnicas(registros);
  if (!fs.length) return null;

  // Una sola formación: aviso puntual, corto.
  if (fs.length === 1) {
    const f = fs[0];
    return `⏰ Demora de +${f.demora} min en el #${f.numero ?? "?"} sentido ${f.sentido}${f.esLocal ? " (local)" : ""}, en ${f.estacion}.`;
  }

  const porSentido = new Map();
  for (const f of fs) {
    if (!porSentido.has(f.sentido)) porSentido.set(f.sentido, []);
    porSentido.get(f.sentido).push(f);
  }
  const grupos = [...porSentido.entries()].sort((a, b) => b[1].length - a[1].length);
  const ventana = textoVentana(fs, ahoraMs);

  const describir = ([sentido, lista]) =>
    `${lista.length === 1 ? "una demora" : `${cuantas(lista.length)} demoras`} sentido ${sentido} (${lista.length} ${plural(lista.length, "tren", "trenes")}, ${rangoDemora(lista)})`;

  if (grupos.length === 1) {
    const [sentido, lista] = grupos[0];
    return `⏰ Se reportan ${cuantas(lista.length)} demoras sentido ${sentido}${ventana}: ${lista.length} trenes, ${rangoDemora(lista)}.`;
  }
  const [principal, ...resto] = grupos;
  return `⏰ Se reportan demoras en ambos sentidos${ventana}: ${describir(principal)}${resto.length ? ` y ${resto.map(describir).join(" y ")}` : ""}.`;
}
