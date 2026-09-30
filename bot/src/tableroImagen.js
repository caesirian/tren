// src/tableroImagen.js
// Dibuja el tablero como una IMAGEN real con código (no con un modelo
// generativo) — los datos son exactos siempre, letra por letra. Diseño por
// COLUMNAS (una por formación), calcado del cartel real de Trenes
// Argentinos en las estaciones. Complementa a /tablero-vivo (la página en
// vivo que sirve el bot) — esto es para mandar una foto fija directo en el
// chat de Telegram.

import { createCanvas } from "@napi-rs/canvas";
import { STATIONS } from "./schedule.js";

const ANCHO_COL = 172;
const ALTO_BANNER = 46;
const ALTO_HEADER_ROSA = 70;
const ALTO_COL_HEADER = 96;
const ALTO_ESTADO = 30;
const ALTO_FILA_ESTACION = 22;
const ALTO_PIE = 34;

const COLOR_BANNER = "#0e1726";
const COLOR_ROSA_1 = "#f6dede";
const COLOR_ROSA_2 = "#f1c9c9";
const COLOR_TABLERO_1 = "#0c1f4d";
const COLOR_TABLERO_2 = "#122a5c";
const COLOR_TEXTO_CLARO = "#ffffff";
const COLOR_TEXTO_OSCURO = "#1a1a2e";
const COLOR_CONFIRMADO = "#1f8a3b";
const COLOR_CANCELADO = "#c62828";
const COLOR_OTRO = "#8a6d1f";
const COLOR_TICKER = "#e08a2c";

function colorEstado(estado) {
  const e = (estado || "").toUpperCase();
  if (e.includes("CANCEL")) return COLOR_CANCELADO;
  if (e.includes("CONFIRM")) return COLOR_CONFIRMADO;
  return COLOR_OTRO;
}

function listaParadas(idOrigen) {
  return STATIONS.filter((s) => s.id !== idOrigen).map((s) => s.name);
}

const NOMBRE_VISIBLE = { Padua: "San Antonio de Padua" };

// Paradas de UNA columna: las reales de ese servicio (recorrido acortado si
// el servicio está limitado); si no vienen, todo el ramal como antes.
function paradasDeColumna(f, paradasCompletas) {
  const base = Array.isArray(f.paradas) && f.paradas.length ? f.paradas : paradasCompletas;
  return base.map((n) => NOMBRE_VISIBLE[n] || n);
}

// filas: [{ anden, horaProgramada, horaEstimada, destino, estado }]
// origenNombre: "Once" o "Moreno" (cabecera desde donde salen)
export function generarImagenTablero(filas, origenNombre, horaActualTexto) {
  const columnas = filas.slice(0, 5); // el cartel real muestra 5 a la vez
  const origen = STATIONS.find((s) => s.name.toLowerCase() === origenNombre.toLowerCase());
  const paradas = listaParadas(origen?.id ?? 0);

  const anchoTablero = columnas.length * ANCHO_COL;
  const paradasPorColumna = columnas.map((f) => paradasDeColumna(f, paradas));
  const maxParadas = Math.max(1, ...paradasPorColumna.map((p) => p.length));
  const altoParadas = maxParadas * ALTO_FILA_ESTACION;
  const altoTotal =
    ALTO_BANNER + ALTO_HEADER_ROSA + ALTO_COL_HEADER + ALTO_ESTADO + altoParadas + ALTO_PIE;

  const canvas = createCanvas(anchoTablero, altoTotal);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "middle";

  ctx.fillStyle = COLOR_BANNER;
  ctx.fillRect(0, 0, anchoTablero, ALTO_BANNER);
  ctx.fillStyle = "#c9d4e3";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("TRENES ARGENTINOS · LÍNEA SARMIENTO", 16, ALTO_BANNER / 2);

  const yRosa = ALTO_BANNER;
  ctx.fillStyle = COLOR_ROSA_1;
  ctx.fillRect(0, yRosa, anchoTablero, ALTO_HEADER_ROSA);
  ctx.fillStyle = COLOR_TEXTO_OSCURO;
  ctx.font = "bold 30px sans-serif";
  ctx.fillText(origenNombre.toUpperCase(), 16, yRosa + ALTO_HEADER_ROSA / 2);
  ctx.textAlign = "right";
  ctx.font = "13px sans-serif";
  ctx.fillText("HORA ACTUAL", anchoTablero - 16, yRosa + ALTO_HEADER_ROSA / 2 - 14);
  ctx.font = "bold 26px sans-serif";
  ctx.fillText(horaActualTexto, anchoTablero - 16, yRosa + ALTO_HEADER_ROSA / 2 + 12);
  ctx.textAlign = "left";

  const yColHeader = yRosa + ALTO_HEADER_ROSA;

  columnas.forEach((f, i) => {
    const x = i * ANCHO_COL;
    const fondoCol = i % 2 === 0 ? COLOR_TABLERO_1 : COLOR_TABLERO_2;

    ctx.fillStyle = i % 2 === 0 ? COLOR_ROSA_1 : COLOR_ROSA_2;
    ctx.fillRect(x, yColHeader, ANCHO_COL, ALTO_COL_HEADER);
    ctx.fillStyle = COLOR_TEXTO_OSCURO;
    ctx.font = "11px sans-serif";
    ctx.fillText("ANDÉN", x + 12, yColHeader + 16);
    ctx.font = "bold 26px sans-serif";
    ctx.fillText(f.anden ?? "-", x + 12, yColHeader + 42);

    ctx.font = "11px sans-serif";
    ctx.fillText("HORA SALIDA", x + 12, yColHeader + 66);
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(f.horaEstimada || f.horaProgramada || "-", x + 12, yColHeader + 88);

    const yEstado = yColHeader + ALTO_COL_HEADER;
    ctx.fillStyle = colorEstado(f.estado);
    ctx.fillRect(x, yEstado, ANCHO_COL, ALTO_ESTADO);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText((f.estado || "S/D").toUpperCase(), x + ANCHO_COL / 2, yEstado + ALTO_ESTADO / 2);
    ctx.textAlign = "left";

    const yParadas = yEstado + ALTO_ESTADO;
    ctx.fillStyle = fondoCol;
    ctx.fillRect(x, yParadas, ANCHO_COL, altoParadas);

    ctx.fillStyle = COLOR_TEXTO_CLARO;
    ctx.font = "13px sans-serif";
    const paradasCol = paradasPorColumna[i];
    paradasCol.forEach((nombre, j) => {
      const y = yParadas + j * ALTO_FILA_ESTACION + ALTO_FILA_ESTACION / 2;
      const esUltima = j === paradasCol.length - 1;
      if (esUltima) ctx.font = "bold 13px sans-serif";
      ctx.fillText(nombre.toUpperCase(), x + 12, y);
      if (esUltima) ctx.font = "13px sans-serif";
    });

    if (i > 0) {
      ctx.strokeStyle = "#3a5a8f";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yColHeader);
      ctx.lineTo(x, altoTotal - ALTO_PIE);
      ctx.stroke();
    }
  });

  const yTicker = altoTotal - ALTO_PIE;
  ctx.fillStyle = COLOR_TICKER;
  ctx.fillRect(0, yTicker, anchoTablero, ALTO_PIE);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText("Datos en vivo — bot Tren Sarmiento En Línea", 16, yTicker + ALTO_PIE / 2);

  return canvas.toBuffer("image/png");
}

// --- Tablero de estación intermedia ("PRÓXIMO TREN" en minutos), por
// sentido — calcado del cartel real de las estaciones del medio del ramal
// (Morón, Castelar, etc.), distinto al de las cabeceras (Once/Moreno).

const COLOR_HEADER_GRIS = "#e9e9ea";
const COLOR_CAJA_AZUL = "#141a52";
const COLOR_LINEA_CELESTE = "#33c9f0";
const COLOR_PIE_AZUL = "#1560c9";

// proximos: [{ enMinutos, hora }] — al menos 1, hasta 3 (próximo/siguiente/subsiguiente)
export function generarImagenProximoTren(estacionNombre, sentidoDestino, proximos, horaActualTexto) {
  const ANCHO = 900;
  const ALTO = 560;
  const canvas = createCanvas(ANCHO, ALTO);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "middle";

  const altoHeader = 90;
  ctx.fillStyle = COLOR_HEADER_GRIS;
  ctx.fillRect(0, 0, ANCHO, altoHeader);
  ctx.fillStyle = "#274b8f";
  ctx.font = "bold 34px sans-serif";
  ctx.fillText(estacionNombre.toUpperCase(), 24, altoHeader / 2);
  ctx.textAlign = "right";
  ctx.font = "16px sans-serif";
  ctx.fillText("HORA", ANCHO - 24, altoHeader / 2 - 16);
  ctx.font = "bold 30px sans-serif";
  ctx.fillStyle = "#33c9f0";
  ctx.fillText("ACTUAL " + horaActualTexto, ANCHO - 24, altoHeader / 2 + 14);
  ctx.textAlign = "left";

  const yCuerpo = altoHeader + 6;
  const altoCuerpo = ALTO - altoHeader - 6 - 44;
  const anchoIzq = ANCHO * 0.55;

  ctx.strokeStyle = COLOR_LINEA_CELESTE;
  ctx.lineWidth = 3;
  ctx.strokeRect(6, yCuerpo, anchoIzq - 12, altoCuerpo - 6);
  ctx.fillStyle = COLOR_CAJA_AZUL;
  ctx.fillRect(9, yCuerpo + 46, anchoIzq - 18, altoCuerpo - 6 - 46);
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(9, yCuerpo, anchoIzq - 18, 46);
  ctx.fillStyle = "#1a1a2e";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("PRÓXIMO TREN", 26, yCuerpo + 24);

  const proximo = proximos[0];
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 130px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(proximo?.enMinutos ?? "-"), anchoIzq / 2, yCuerpo + 46 + 130);
  ctx.font = "22px sans-serif";
  ctx.fillText("MINUTOS", anchoIzq / 2, yCuerpo + 46 + 200);
  ctx.textAlign = "left";
  ctx.strokeStyle = COLOR_LINEA_CELESTE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(26, yCuerpo + altoCuerpo - 60);
  ctx.lineTo(anchoIzq - 34, yCuerpo + altoCuerpo - 60);
  ctx.stroke();
  ctx.fillStyle = "#cfd6f5";
  ctx.font = "16px sans-serif";
  ctx.fillText("DESTINO:", 26, yCuerpo + altoCuerpo - 30);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText((proximo?.destino || sentidoDestino).toUpperCase(), 150, yCuerpo + altoCuerpo - 30);

  const xDer = anchoIzq + 6;
  const anchoDer = ANCHO - xDer - 6;
  const alturas = [0, (altoCuerpo - 6) / 2];
  const etiquetas = ["SIGUIENTE", "SUBSIGUIENTE"];

  [proximos[1], proximos[2]].forEach((p, i) => {
    const yBox = yCuerpo + alturas[i];
    const hBox = (altoCuerpo - 6) / 2;
    ctx.strokeStyle = COLOR_LINEA_CELESTE;
    ctx.lineWidth = 2;
    ctx.strokeRect(xDer, yBox, anchoDer, hBox - 4);
    ctx.fillStyle = COLOR_CAJA_AZUL;
    ctx.fillRect(xDer + 2, yBox + 2, anchoDer - 4, hBox - 8);

    ctx.fillStyle = "#cfd6f5";
    ctx.font = "bold 18px sans-serif";
    ctx.fillText(`${etiquetas[i]}`, xDer + 20, yBox + 26);
    ctx.fillText("TREN EN:", xDer + 20, yBox + 50);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px sans-serif";
    ctx.fillText(p ? String(p.enMinutos) : "-", xDer + 180, yBox + 45);
    ctx.font = "16px sans-serif";
    ctx.fillText("MINUTOS", xDer + 320, yBox + 45);

    ctx.strokeStyle = COLOR_LINEA_CELESTE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xDer + 20, yBox + hBox - 34);
    ctx.lineTo(xDer + anchoDer - 20, yBox + hBox - 34);
    ctx.stroke();
    ctx.fillStyle = "#cfd6f5";
    ctx.font = "14px sans-serif";
    ctx.fillText("DESTINO:", xDer + 20, yBox + hBox - 16);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText((p?.destino || sentidoDestino).toUpperCase(), xDer + 130, yBox + hBox - 16);
  });

  const yTicker = yCuerpo + altoCuerpo + 4;
  ctx.fillStyle = COLOR_TICKER;
  ctx.fillRect(0, yTicker, ANCHO, 24);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText("El servicio funciona con normalidad — datos en vivo", 16, yTicker + 12);

  const yPie = yTicker + 24;
  ctx.fillStyle = COLOR_PIE_AZUL;
  ctx.fillRect(0, yPie, ANCHO, ALTO - yPie);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("TRENES ARGENTINOS · LÍNEA SARMIENTO", 16, yPie + (ALTO - yPie) / 2);

  return canvas.toBuffer("image/png");
}
