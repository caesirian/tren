// src/mapaDemorasImagen.js
// Mapa VERTICAL de las vías (Once arriba, Moreno abajo) como imagen PNG para
// acompañar el aviso de demoras. Dibujado con código (datos exactos, sin modelo
// generativo). Dos vías: sentido Once (izquierda) y sentido Moreno (derecha).
//   · punto chico sobre la vía; a un costado, el número de la formación
//   · violeta = local · gris = común
//   · aro rojo + número en rojo con los minutos = formación con demora
//
// MAPA_DEMORAS_MODO: "privado" (por defecto: solo se lo manda al admin),
// "grupo" (el aviso del grupo sale con el mapa como foto) u "off".

import { createCanvas } from "@napi-rs/canvas";
import { barridoEstructurado, posicionesEnVivo, hora } from "./appTrenes.js";
import { clasificarServicio } from "./locales.js";

export const UMBRAL_DEMORA_MIN = 10; // mismo umbral que el aviso de demoras

// Mismo orden que ESTACIONES_BARRIDO / COORDS_ESTACIONES (0 = Once … 15 = Moreno).
const NOMBRES = ["Once", "Caballito", "Flores", "Floresta", "Villa Luro", "Liniers", "Ciudadela", "Ramos Mejía", "Haedo", "Morón", "Castelar", "Ituzaingó", "San A. de Padua", "Merlo", "Paso del Rey", "Moreno"];

const S = 2; // escala (la imagen sale al doble para que se lea bien en el celu)
const W = 340;
const H = 430;
const X_VIA_ONCE = 112;
const X_VIA_MORENO = 215;
const Y0 = 68;
const PASO = 21;
const SEPARACION_ETIQUETAS = 14;

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
    }));
}

function circulo(ctx, x, y, r, relleno, borde, ancho = 1) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (relleno) { ctx.fillStyle = relleno; ctx.fill(); }
  if (borde) { ctx.strokeStyle = borde; ctx.lineWidth = ancho; ctx.stroke(); }
}

function etiquetaPartes(t) {
  const demorado = t.demora >= UMBRAL_DEMORA_MIN;
  const partes = [{ txt: String(t.numero ?? "?"), color: demorado ? C.textoDemora : C.suave }];
  if (t.local) partes.push({ txt: " local", color: demorado ? C.textoDemora : C.textoLocal });
  if (demorado) partes.push({ txt: ` +${t.demora} min`, color: C.textoDemora });
  return { partes, demorado };
}

// trenes: salida de trenesParaMapa(). Devuelve un Buffer PNG.
export function generarImagenMapaDemoras(trenes, horaTexto = "") {
  const canvas = createCanvas(W * S, H * S);
  const ctx = canvas.getContext("2d");
  ctx.scale(S, S);
  ctx.textBaseline = "middle";

  ctx.fillStyle = C.fondo;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "left";
  ctx.fillStyle = C.texto;
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("Tren Sarmiento · formaciones", 8, 14);
  if (horaTexto) {
    ctx.textAlign = "right";
    ctx.fillStyle = C.suave;
    ctx.font = "12px sans-serif";
    ctx.fillText(horaTexto, W - 8, 14);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = C.texto;
  ctx.font = "bold 12px sans-serif";
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
  ctx.font = "12px sans-serif";
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

  // Separa por vía y acomoda las etiquetas para que no se pisen (los puntos no se mueven).
  const vias = [
    { x: X_VIA_ONCE, lista: [] },
    { x: X_VIA_MORENO, lista: [] },
  ];
  for (const t of trenes) {
    const pos = Math.min(Math.max(t.posicion, 0), NOMBRES.length - 1);
    const via = /^moreno-once$/i.test(t.sentido || "") ? vias[0] : vias[1];
    via.lista.push({ ...t, y: Y0 + pos * PASO, yEtiqueta: 0 });
  }
  for (const via of vias) {
    via.lista.sort((a, b) => a.y - b.y);
    let previo = -Infinity;
    for (const t of via.lista) {
      t.yEtiqueta = Math.max(t.y, previo + SEPARACION_ETIQUETAS);
      previo = t.yEtiqueta;
    }
  }

  // Puntos (primero los comunes, arriba de todo los demorados para que el aro no quede tapado).
  const todos = vias.flatMap((v) => v.lista.map((t) => ({ ...t, x: v.x })));
  todos.sort((a, b) => Number(a.demora >= UMBRAL_DEMORA_MIN) - Number(b.demora >= UMBRAL_DEMORA_MIN));
  for (const t of todos) {
    const colorTipo = t.local ? C.local : C.comun;
    if (t.demora >= UMBRAL_DEMORA_MIN) {
      circulo(ctx, t.x, t.y, 10, C.halo, C.demora, 1);
      circulo(ctx, t.x, t.y, 5, colorTipo, null);
    } else {
      circulo(ctx, t.x, t.y, 4, colorTipo, null);
    }
  }

  // Etiquetas al costado de cada punto (a la derecha de la vía).
  for (const t of todos) {
    const { partes, demorado } = etiquetaPartes(t);
    let x = t.x + (demorado ? 15 : 12);
    for (const p of partes) {
      ctx.font = `${demorado ? "bold " : ""}12px sans-serif`;
      ctx.fillStyle = p.color;
      ctx.textAlign = "left";
      ctx.fillText(p.txt, x, t.yEtiqueta);
      x += ctx.measureText(p.txt).width;
    }
  }

  // Referencias
  const yLeyenda = H - 20;
  ctx.textAlign = "left";
  ctx.font = "12px sans-serif";
  circulo(ctx, 16, yLeyenda, 4, C.comun, null);
  ctx.fillStyle = C.suave;
  ctx.fillText("Común", 26, yLeyenda);
  circulo(ctx, 96, yLeyenda, 4, C.local, null);
  ctx.fillStyle = C.suave;
  ctx.fillText("Local", 106, yLeyenda);
  circulo(ctx, 176, yLeyenda, 7, C.halo, C.demora, 1);
  circulo(ctx, 176, yLeyenda, 3, C.comun, null);
  ctx.fillStyle = C.suave;
  ctx.fillText("Con demora", 190, yLeyenda);

  return canvas.toBuffer("image/png");
}

// Atajo para el bot: barrido + dibujo. Devuelve { png, trenes, demorados }.
export async function imagenMapaDemoras() {
  const trenes = await trenesParaMapa();
  const png = generarImagenMapaDemoras(trenes, hora(new Date().toISOString()));
  return { png, trenes, demorados: trenes.filter((t) => t.demora >= UMBRAL_DEMORA_MIN).length };
}
