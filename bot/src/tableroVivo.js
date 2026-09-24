// src/tableroVivo.js
// HTML del tablero en tiempo real, estilo cartelera física de estación
// (como la de Once): columnas por próxima salida, con andén, hora, destino,
// estado (PROGRAMADO/CONFIRMADO/CANCELADO) y el listado de estaciones del
// ramal debajo de cada una. Página autocontenida, servida por este mismo bot
// en GET /tablero-vivo. Consulta a GET /api/tablero-cabecera cada 20s.
export function tableroVivoHTML() {
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tablero en vivo — Sarmiento</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #050810; color: #e6edf3; }
  header { padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; border-bottom: 2px solid #1c2b3a; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; color: #9fb0c0; }
  .sub { font-size: 11.5px; color: #5b6773; margin-top: 2px; }
  #estado { font-size: 12px; color: #5b6773; }
  select#estSel { background: #0d1520; color: #cfe8f7; border: 1px solid #1c2b3a; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .board { background: #0a1420; border: 3px solid #1c74a8; border-radius: 4px; margin: 16px; overflow: hidden; }
  .board-top { display: flex; justify-content: space-between; align-items: center; background: linear-gradient(#f3e6da, #e9d5c2); color: #1a2c42; padding: 8px 16px; }
  .board-top .est-nombre { font-size: 20px; font-weight: 800; letter-spacing: .5px; }
  .board-top .hora-actual-label { font-size: 11px; color: #6b5b4d; text-transform: uppercase; letter-spacing: 1px; }
  .board-top .hora-actual { font-size: 22px; font-weight: 800; color: #0e63b0; font-variant-numeric: tabular-nums; }
  .columnas { display: flex; overflow-x: auto; }
  .col { flex: 1 0 150px; min-width: 150px; border-right: 2px solid #1c74a8; }
  .col:last-child { border-right: none; }
  .col-head { background: linear-gradient(#f3e6da, #e9d5c2); color: #1a2c42; text-align: center; padding: 6px 4px; border-bottom: 2px solid #1c74a8; }
  .col-head .anden-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #6b5b4d; }
  .col-head .anden-num { font-size: 20px; font-weight: 800; line-height: 1.1; }
  .col-head .hora-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #6b5b4d; margin-top: 2px; }
  .col-head .hora-num { font-size: 18px; font-weight: 800; }
  .col-destino { text-align: center; font-size: 15px; font-weight: 800; letter-spacing: .5px; padding: 6px 4px; background: #0a1420; }
  .col-estado { text-align: center; font-size: 11.5px; font-weight: 700; letter-spacing: .5px; padding: 4px; text-transform: uppercase; }
  .col-estado.confirmado { background: #146a3a; color: #c9f5d9; }
  .col-estado.programado { background: #14324a; color: #bcdff5; }
  .col-estado.cancelado { background: #7a1414; color: #ffd0d0; }
  .col-paradas { list-style: none; margin: 0; padding: 6px 8px 12px; font-size: 11.5px; color: #a9c3d6; line-height: 1.7; }
  .ticker { background: #b4501a; color: #fff; padding: 7px 16px; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; }
  .ticker span { display: inline-block; padding-left: 100%; animation: mover 18s linear infinite; }
  @keyframes mover { from { transform: translateX(0); } to { transform: translateX(-100%); } }
  #vacio { padding: 40px; text-align: center; color: #5b6773; }
  footer { text-align: center; color: #4b5563; font-size: 11px; padding: 16px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>🚆 Sarmiento — tablero en vivo</h1>
    <div class="sub">Estilo cartelera de estación · datos del proxy de la app de Trenes Argentinos (no oficial)</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <select id="estSel"><option value="Once">Once</option><option value="Moreno">Moreno</option></select>
    <div id="estado">conectando…</div>
  </div>
</header>
<div class="board" id="board" style="display:none">
  <div class="board-top">
    <div class="est-nombre" id="boardEst">ONCE</div>
    <div style="text-align:right"><div class="hora-actual-label">Hora actual</div><div class="hora-actual" id="boardHora">--:--</div></div>
  </div>
  <div class="columnas" id="columnas"></div>
</div>
<div id="vacio" style="display:none">Sin próximas salidas para mostrar en este momento.</div>
<div class="ticker" id="ticker" style="display:none"><span id="tickerTxt"></span></div>
<footer>Fuente: proxy no oficial de la app de Trenes Argentinos (ariedro/api-trenes) — no es un dato oficial garantizado.</footer>
<script>
(function () {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  const sel = document.getElementById("estSel");
  const board = document.getElementById("board");
  const columnas = document.getElementById("columnas");
  const vacio = document.getElementById("vacio");
  const estadoEl = document.getElementById("estado");
  const boardEst = document.getElementById("boardEst");
  const boardHora = document.getElementById("boardHora");
  const ticker = document.getElementById("ticker");
  const tickerTxt = document.getElementById("tickerTxt");

  function urlFor(estacion) {
    const qs = new URLSearchParams({ estacion });
    if (key) qs.set("key", key);
    return "/api/tablero-cabecera?" + qs.toString();
  }

  function render(data) {
    const cols = data.columnas || [];
    board.style.display = cols.length ? "block" : "none";
    vacio.style.display = cols.length ? "none" : "block";
    boardEst.textContent = (data.estacion || "").toUpperCase();
    boardHora.textContent = data.horaActual || "--:--";

    columnas.innerHTML = cols
      .map((c) => {
        const estadoClase = c.cancelado ? "cancelado" : /confirmado/i.test(c.estado || "") ? "confirmado" : "programado";
        const estadoTxt = c.cancelado ? "Cancelado" : c.estado || "Programado";
        const paradas = (data.estaciones || []).map((e) => "<li>" + e + "</li>").join("");
        return '<div class="col">' +
          '<div class="col-head"><div class="anden-label">Andén</div><div class="anden-num">' + (c.anden || "–") + '</div>' +
          '<div class="hora-label">Hora salida</div><div class="hora-num">' + (c.horaSalida || "--:--") + '</div></div>' +
          '<div class="col-destino">' + (c.destino || "?").toUpperCase() + '</div>' +
          '<div class="col-estado ' + estadoClase + '">' + estadoTxt + '</div>' +
          '<ul class="col-paradas">' + paradas + '</ul>' +
          '</div>';
      })
      .join("");

    const motivos = cols.filter((c) => c.cancelado && c.motivoCancelacion).map((c) => c.motivoCancelacion);
    if (motivos.length) {
      ticker.style.display = "block";
      tickerTxt.textContent = motivos.join("   •   ");
    } else {
      ticker.style.display = "none";
    }
  }

  let ultimoOk = 0;
  async function actualizar() {
    try {
      const res = await fetch(urlFor(sel.value), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      render(data);
      ultimoOk = Date.now();
      estadoEl.textContent = "actualizado " + (data.consultadoEn ? new Date(data.consultadoEn).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "");
    } catch (err) {
      const seg = ultimoOk ? Math.round((Date.now() - ultimoOk) / 1000) : null;
      estadoEl.textContent = seg ? "sin conexión hace " + seg + "s" : "no pude conectar";
    }
  }

  sel.addEventListener("change", actualizar);
  actualizar();
  setInterval(actualizar, 20000);
})();
</script>
</body>
</html>`;
}
