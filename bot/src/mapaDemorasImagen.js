// src/mapaDemorasImagen.js
// Mapa VERTICAL de las vías (Once arriba, Moreno abajo) como imagen PNG para
// acompañar el aviso de demoras. Dibujado con código (datos exactos, sin modelo
// generativo). Dos vías: sentido Once (izquierda) y sentido Moreno (derecha).
//   · punto chico sobre la vía; a un costado, el número de la formación
//   · violeta = local · gris = común
//   · punto lleno = ubicación por GPS · punto hueco = estimada por horarios
//   · aro rojo + número en rojo con los minutos = formación con demora
//   · las formaciones que figuran en una cabecera (Once/Moreno) se juntan en una
//     sola línea ("5 por salir" / "4 llegaron"); de ésas solo se detallan las que
//     tienen demora
//
// Fuente: Roboto incluida en assets/fonts (el servidor no trae fuentes y sin esto
// el texto sale en serif y se corta). MAPA_DEMORAS_MODO: "privado" (por defecto:
// solo se lo manda al admin), "grupo" (el aviso del grupo sale con el mapa como
// foto) u "off".

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { barridoEstructurado, posicionesEnVivo, hora } from "./appTrenes.js";
import { clasificarServicio } from "./locales.js";

export const UMBRAL_DEMORA_MIN = 10; // mismo umbral que el aviso de demoras

const DIR_FUENTES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
let FUENTE = "sans-serif";
try {
  const a = GlobalFonts.registerFromPath(path.join(DIR_FUENTES, "Roboto_400Regular.ttf"), "MapaRoboto");
  const b = GlobalFonts.registerFromPath(path.join(DIR_FUENTES, "Roboto_700Bold.ttf"), "MapaRoboto");
  if (a || b) FUENTE = "MapaRoboto";
} catch (err) {
  console.error("mapaDemorasImagen: no pude registrar la fuente Roboto, uso la del sistema:", err.message);
}
const fuente = (px, negrita = false) => `${negrita ? "bold " : ""}${px}px ${FUENTE}, sans-serif`;

// Mismo orden que ESTACIONES_BARRIDO / COORDS_ESTACIONES (0 = Once … 15 = Moreno).
const NOMBRES = ["Once", "Caballito", "Flores", "Floresta", "Villa Luro", "Liniers", "Ciudadela", "Ramos Mejía", "Haedo", "Morón", "Castelar", "Ituzaingó", "San A. de Padua", "Merlo", "Paso del Rey", "Moreno"];

const S = 2; // escala (la imagen sale al doble para que se lea bien en el celu)
const W = 340;
const X_VIA_ONCE = 112;
const X_VIA_MORENO = 215;
const Y0 = 68;
const PASO = 21;
const SEPARACION_ETIQUETAS = 14;
const MARGEN_CABECERA = 0.15; // a menos de esto de una cabecera = "en cabecera"
const MAX_DEMORADOS_CABECERA = 3;

const C = {
  fondo: "#ffffff",
  texto: "#2c2c2a",
  suave: "#5f5e5a",
  via: "#cfcdc4",
  tick: "#b4b2a9",
  comun: "#888780",
  local: "#7f77dd",
  textoLocal: "#534ab7",
  demora: "#e24b4a",
  textoDemora: "#a32d2d",
  halo: "#fceBEB",
};

export function mapaDemorasModo() {
  const m = String(process.env.MAPA_DEMORAS_MODO ?? "privado").trim().toLowerCase();
  return ["off", "grupo"].includes(m) ? m : "privado";
}

// Trenes del barrido listos para dibujar: { numero, sentido, posicion, demora, local }.
export async function trenesParaMapa() {
  const barrido = await barridoEstructurado();
  const trenes = posicionesEnVivo(barrido.todos, new Date());
  const locales = new Set();
  for (const item of barrido.todos) {
    try {
      const c = clasificarServicio(item);
      if (c.esLocal && c.numero != null) locales.add(c.numero);
    } catch {
      // si no se puede clasificar, se dibuja como común
    }
  }
  return trenes
    .filter((t) => !t.cancelado && Number.isFinite(t.posicion))
    .map((t) => ({
      numero: t.numero,
      sentido: t.sentido,
      posicion: t.posicion,
      demora: t.demoraMax || 0,
      local: t.numero != null && locales.has(t.numero),
      fuente: t.fuente === "gps" ? "gps" : "estimada",
    }));
}

function circulo(ctx, x, y, r, relleno, borde, ancho = 1) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (relleno) { ctx.fillStyle = relleno; ctx.fill(); }
  if (borde) { ctx.strokeStyle = borde; ctx.lineWidth = ancho; ctx.stroke(); }
}

const esDemorado = (t) => t.demora >= UMBRAL_DEMORA_MIN;
const esGps = (t) => t.fuente === "gps";

function partesDeTren(t) {
  const dem = esDemorado(t);
  const partes = [{ txt: String(t.numero ?? "?"), color: dem ? C.textoDemora : C.suave }];
  if (t.local) partes.push({ txt: " local", color: dem ? C.textoDemora : C.textoLocal });
  if (dem) partes.push({ txt: ` +${t.demora} min`, color: C.textoDemora });
  return partes;
}

// Arma los elementos de UNA vía: puntos individuales + resumen de cada cabecera.
// idxOrigen = estación donde arrancan las formaciones de esa vía (0 = Once, 15 = Moreno).
// En una cabecera hay dos casos distintos: con GPS la formación está ahí de verdad
// ("en Once"); sin GPS solo sabemos por horarios que figura en esa estación (el barrido
// trae también las próximas salidas), así que en el origen se dice "por salir" y en el
// destino "llegaron".
function elementosDeVia(trenes, idxOrigen) {
  const items = [];
  const ultimo = NOMBRES.length - 1;
  const cabeceras = { 0: [], [ultimo]: [] };
  for (const t of trenes) {
    const pos = Math.min(Math.max(t.posicion, 0), ultimo);
    if (pos <= MARGEN_CABECERA) cabeceras[0].push(t);
    else if (pos >= ultimo - MARGEN_CABECERA) cabeceras[ultimo].push(t);
    else items.push({ y: Y0 + pos * PASO, demorado: esDemorado(t), local: t.local, hueco: !esGps(t), partes: partesDeTren(t), punto: true });
  }
  for (const [idx, lista] of Object.entries(cabeceras)) {
    if (!lista.length) continue;
    const n = Number(idx);
    const y = Y0 + n * PASO;
    const porSalir = n === idxOrigen;
    const conGps = lista.filter(esGps);
    const estimadas = lista.filter((t) => !esGps(t));
    const demorados = lista.filter(esDemorado).sort((a, b) => b.demora - a.demora);
    const hueco = conGps.length === 0;

    if (lista.length === 1) {
      const t = lista[0];
      const partes = partesDeTren(t);
      if (!esDemorado(t)) partes.push({ txt: esGps(t) ? ` en ${NOMBRES[n]}` : porSalir ? " por salir" : " llegó", color: C.suave });
      items.push({ y, demorado: esDemorado(t), local: t.local, hueco, partes, punto: true });
      continue;
    }

    let primero = true;
    const resumen = (txt) => {
      items.push({ y, demorado: demorados.length > 0, negrita: false, local: false, hueco, punto: primero, partes: [{ txt, color: C.suave }] });
      primero = false;
    };
    if (conGps.length) resumen(`${conGps.length} en ${NOMBRES[n]}`);
    if (estimadas.length) resumen(`${estimadas.length} ${porSalir ? "por salir" : "llegaron"}`);
    for (const t of demorados.slice(0, MAX_DEMORADOS_CABECERA)) {
      items.push({ y, demorado: true, local: t.local, punto: false, partes: partesDeTren(t) });
    }
    if (demorados.length > MAX_DEMORADOS_CABECERA) {
      items.push({ y, demorado: true, local: false, punto: false, partes: [{ txt: `+${demorados.length - MAX_DEMORADOS_CABECERA} más con demora`, color: C.textoDemora }] });
    }
  }
  items.sort((a, b) => a.y - b.y);
  let previo = -Infinity;
  for (const it of items) {
    it.yEtiqueta = Math.max(it.y, previo + SEPARACION_ETIQUETAS);
    previo = it.yEtiqueta;
  }
  return items;
}

// trenes: salida de trenesParaMapa(). Devuelve un Buffer PNG.
export function generarImagenMapaDemoras(trenes, horaTexto = "") {
  const vias = [
    { x: X_VIA_ONCE, items: elementosDeVia(trenes.filter((t) => /^moreno-once$/i.test(t.sentido || "")), NOMBRES.length - 1) },
    { x: X_VIA_MORENO, items: elementosDeVia(trenes.filter((t) => !/^moreno-once$/i.test(t.sentido || "")), 0) },
  ];
  // Alto según lo que haya que dibujar (las etiquetas de las cabeceras pueden bajar del final de la vía).
  const yUltimaEtiqueta = Math.max(0, ...vias.flatMap((v) => v.items.map((i) => i.yEtiqueta)));
  const H = Math.ceil(Math.max(Y0 + (NOMBRES.length - 1) * PASO + 24, yUltimaEtiqueta + 16) + 34);
  const canvas = createCanvas(W * S, H * S);
  const ctx = canvas.getContext("2d");
  ctx.scale(S, S);
  ctx.textBaseline = "middle";

  ctx.fillStyle = C.fondo;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "left";
  ctx.fillStyle = C.texto;
  ctx.font = fuente(14, true);
  ctx.fillText("Tren Sarmiento · formaciones", 8, 14);
  if (horaTexto) {
    ctx.textAlign = "right";
    ctx.fillStyle = C.suave;
    ctx.font = fuente(12);
    ctx.fillText(horaTexto, W - 8, 14);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = C.texto;
  ctx.font = fuente(12, true);
  ctx.fillText("Sentido Once", X_VIA_ONCE, 42);
  ctx.fillText("Sentido Moreno", X_VIA_MORENO, 42);

  const yFin = Y0 + (NOMBRES.length - 1) * PASO;
  ctx.strokeStyle = C.via;
  ctx.lineWidth = 2;
  for (const x of [X_VIA_ONCE, X_VIA_MORENO]) {
    ctx.beginPath();
    ctx.moveTo(x, Y0);
    ctx.lineTo(x, yFin);
    ctx.stroke();
  }
  ctx.strokeStyle = C.tick;
  ctx.lineWidth = 1;
  ctx.textAlign = "left";
  ctx.fillStyle = C.suave;
  ctx.font = fuente(12);
  NOMBRES.forEach((nombre, i) => {
    const y = Y0 + i * PASO;
    for (const x of [X_VIA_ONCE, X_VIA_MORENO]) {
      ctx.beginPath();
      ctx.moveTo(x - 6, y);
      ctx.lineTo(x + 6, y);
      ctx.stroke();
    }
    ctx.fillText(nombre, 8, y);
  });

  // Puntos: primero los comunes, arriba los demorados para que el aro no quede tapado.
  const puntos = vias.flatMap((v) => v.items.filter((i) => i.punto).map((i) => ({ ...i, x: v.x })));
  puntos.sort((a, b) => Number(a.demorado) - Number(b.demorado));
  const punto = (x, y, r, colorTipo, hueco) => {
    if (hueco) circulo(ctx, x, y, r, C.fondo, colorTipo, 1.5);
    else circulo(ctx, x, y, r, colorTipo, null);
  };
  for (const p of puntos) {
    const colorTipo = p.local ? C.local : C.comun;
    if (p.demorado) {
      circulo(ctx, p.x, p.y, 10, C.halo, C.demora, 1);
      punto(p.x, p.y, 5, colorTipo, p.hueco);
    } else {
      punto(p.x, p.y, 4, colorTipo, p.hueco);
    }
  }

  // Etiquetas a la derecha de cada vía. Si una no entra en la imagen, se achica la letra.
  ctx.textAlign = "left";
  for (const v of vias) {
    for (const it of v.items) {
      const x0 = v.x + (it.punto && it.demorado ? 15 : 12);
      let px = 12;
      const negrita = it.negrita ?? it.demorado;
      const medir = () => it.partes.reduce((s, p) => { ctx.font = fuente(px, negrita); return s + ctx.measureText(p.txt).width; }, 0);
      while (px > 9 && x0 + medir() > W - 4) px -= 1;
      let x = x0;
      for (const p of it.partes) {
        ctx.font = fuente(px, negrita);
        ctx.fillStyle = p.color;
        ctx.fillText(p.txt, x, it.yEtiqueta);
        x += ctx.measureText(p.txt).width;
      }
    }
  }

  // Referencias
  const yLeyenda = H - 20;
  ctx.font = fuente(12);
  ctx.textAlign = "left";
  ctx.fillStyle = C.suave;
  circulo(ctx, 14, yLeyenda, 4, C.comun, null);
  ctx.fillStyle = C.suave;
  ctx.fillText("Común", 23, yLeyenda);
  circulo(ctx, 76, yLeyenda, 4, C.local, null);
  ctx.fillStyle = C.suave;
  ctx.fillText("Local", 85, yLeyenda);
  circulo(ctx, 134, yLeyenda, 7, C.halo, C.demora, 1);
  circulo(ctx, 134, yLeyenda, 3, C.comun, null);
  ctx.fillStyle = C.suave;
  ctx.fillText("Demora", 146, yLeyenda);
  circulo(ctx, 212, yLeyenda, 4, C.fondo, C.comun, 1.5);
  ctx.fillStyle = C.suave;
  ctx.fillText("Estimada (hueco)", 221, yLeyenda);

  return canvas.toBuffer("image/png");
}

// Atajo para el bot: barrido + dibujo. Devuelve { png, trenes, demorados, porGps, estimadas }.
export async function imagenMapaDemoras() {
  const trenes = await trenesParaMapa();
  const png = generarImagenMapaDemoras(trenes, hora(new Date().toISOString()));
  const porGps = trenes.filter(esGps).length;
  return { png, trenes, demorados: trenes.filter(esDemorado).length, porGps, estimadas: trenes.length - porGps };
}
