// src/tableroVivo.js
// HTML del tablero en tiempo real, calcado del diseño de referencia (fondo
// celeste degradé, columnas andén/hora en navy, destino en blanco, estado en
// verde/rojo, paradas en navy, banner inferior y pie "Trenes Argentinos /
// Línea Sarmiento"). Misma paleta que trensarmientoenlinea.com.ar. Página
// autocontenida, servida por este bot en GET /tablero-vivo. Consulta a
// GET /api/tablero-cabecera cada 20s.
export function tableroVivoHTML() {
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tablero en vivo — Sarmiento</title>
<style>
  :root {
    --navy:#002B5C; --blue:#0055A4; --celeste:#0095D4; --cel-light:#D6EDF7; --cel-bg:#EEF6FB;
    --text:#1A2C42; --muted:#5A7A99; --border:#CDDAEA; --bg:#F2F7FB; --card:#FFFFFF;
    --green:#15803D; --green-bg:#DCFCE7; --red:#DC2626; --red-bg:#FEE2E2;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
  .topbar { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; background: var(--card); border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--muted); flex-wrap: wrap; gap: 8px; }
  .topbar select { padding: 5px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--text); font-size: 13px; }
  .board { margin: 14px; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,43,92,.14); }
  .board-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 26px; background: linear-gradient(100deg, #4FC3F0 0%, var(--celeste) 45%, var(--blue) 100%); }
  .board-head .est-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .board-head .est-nombre { font-size: 30px; font-weight: 800; color: var(--navy); letter-spacing: .5px; }
  .board-head .est-sub { font-size: 19px; font-weight: 600; color: #eaf6fd; }
  .board-head .hora-wrap { display: flex; align-items: center; gap: 14px; }
  .board-head .hora-label { text-align: right; font-size: 11px; font-weight: 700; color: #eaf6fd; letter-spacing: 1px; line-height: 1.3; }
  .board-head .divisor { width: 2px; align-self: stretch; background: rgba(255,255,255,.55); border-radius: 2px; }
  .board-head .hora-num { font-size: 38px; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums; }
  .columnas { display: flex; background: #fff; overflow-x: auto; }
  .col { flex: 1 0 165px; min-width: 165px; border-right: 6px solid var(--bg); }
  .col:last-child { border-right: none; }
  .col-head { display: flex; background: var(--navy); }
  .col-head > div { flex: 1; text-align: center; padding: 9px 4px; }
  .col-head > div:first-child { border-right: 1px solid rgba(255,255,255,.18); }
  .col-head .lbl { font-size: 9.5px; font-weight: 700; letter-spacing: 1.5px; color: #93B4D6; text-transform: uppercase; }
  .col-head .val { font-size: 21px; font-weight: 800; color: #fff; margin-top: 2px; }
  .col-destino { text-align: center; font-size: 16px; font-weight: 800; color: var(--navy); padding: 12px 6px; background: #fff; letter-spacing: .3px; }
  .col-origen-inusual { text-align: center; font-size: 10.5px; font-weight: 700; color: #4338CA; background: #EEF0FF; padding: 3px 6px; margin: 0 8px 6px; border-radius: 6px; }
  .tren-origen-inusual { outline: 3px solid #4338CA; outline-offset: 1px; }
  .col-estado { text-align: center; font-size: 12.5px; font-weight: 800; letter-spacing: 1px; padding: 8px; text-transform: uppercase; color: #fff; }
  .col-estado.confirmado { background: var(--green); }
  .col-estado.programado { background: var(--celeste); }
  .col-estado.cancelado { background: var(--red); }
  .col-paradas { list-style: none; margin: 0; padding: 12px 0 18px; background: var(--navy); }
  .col-paradas li { text-align: center; font-size: 12px; font-weight: 700; letter-spacing: .3px; color: #C9DCF0; padding: 4px 6px; }
  .banner { padding: 16px 26px; text-align: center; font-size: 19px; font-weight: 800; }
  .banner.tip { background: var(--green-bg); color: var(--green); }
  .banner.alerta { background: var(--red-bg); color: var(--red); }
  .footer-bar { display: flex; align-items: center; gap: 12px; background: var(--blue); padding: 12px 22px; }
  .footer-bar .barra { width: 3px; align-self: stretch; background: #fff; border-radius: 2px; }
  .footer-bar .marca-chica { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #cfe3f5; text-transform: uppercase; }
  .footer-bar .marca-grande { font-size: 15px; font-weight: 800; color: #fff; }
  #vacio { padding: 60px 20px; text-align: center; color: var(--muted); background: var(--card); border-radius: 14px; margin: 14px; }
  footer.credito { text-align: center; color: #9AA9B8; font-size: 11px; padding: 14px; }
</style>
</head>
<body>
<div class="topbar">
  <span>🚆 Sarmiento — tablero en vivo (no oficial)</span>
  <div style="display:flex;align-items:center;gap:10px;">
    <select id="estSel"><option value="Once">Once</option><option value="Moreno">Moreno</option></select>
    <span id="estado">conectando…</span>
  </div>
</div>

<div class="board" id="board" style="display:none">
  <div class="board-head">
    <div class="est-line"><span class="est-nombre" id="boardEst">ONCE</span><span class="est-sub">Próximas Salidas</span></div>
    <div class="hora-wrap">
      <div class="hora-label">HORA<br>ACTUAL</div>
      <div class="divisor"></div>
      <div class="hora-num" id="boardHora">--:--</div>
    </div>
  </div>
  <div class="columnas" id="columnas"></div>
  <div class="banner tip" id="banner">Las personas con CUD pueden viajar en tren sin costo con SUBE.</div>
  <div class="footer-bar">
    <div class="barra"></div>
    <div><div class="marca-chica">Trenes Argentinos</div><div class="marca-grande">Línea Sarmiento</div></div>
  </div>
</div>
<div id="vacio" style="display:none">Sin próximas salidas para mostrar en este momento.</div>
<footer class="credito">Fuente: proxy no oficial de la app de Trenes Argentinos (ariedro/api-trenes) — no es un dato oficial garantizado.</footer>

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
  const banner = document.getElementById("banner");
  const TIP_DEFAULT = "Las personas con CUD pueden viajar en tren sin costo con SUBE.";

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
        const estadoClase = c.cancelado ? "cancelado" : /en\\s*and[eé]n|confirmado|parti[oó]/i.test(c.estado || "") ? "confirmado" : "programado";
        const estadoTxt = c.cancelado ? "Cancelado" : c.estado || "Programado";
        const paradas = (data.estaciones || []).map((e) => "<li>" + e + "</li>").join("");
        return '<div class="col">' +
          '<div class="col-head"><div><div class="lbl">Andén</div><div class="val">' + (c.anden || "–") + '</div></div>' +
          '<div><div class="lbl">Hora salida</div><div class="val">' + (c.horaSalida || "--:--") + '</div></div></div>' +
          '<div class="col-destino">' + (c.destino || "?").toUpperCase() + '</div>' +
          (c.origenInusual ? '<div class="col-origen-inusual">⚠ Sale de ' + c.origen + '</div>' : "") +
          '<div class="col-estado ' + estadoClase + '">' + estadoTxt + '</div>' +
          '<ul class="col-paradas">' + paradas + '</ul>' +
          '</div>';
      })
      .join("");

    const motivos = cols.filter((c) => c.cancelado && c.motivoCancelacion).map((c) => c.motivoCancelacion);
    if (motivos.length) {
      banner.className = "banner alerta";
      banner.textContent = "⚠️ " + motivos.join("   •   ");
    } else {
      banner.className = "banner tip";
      banner.textContent = TIP_DEFAULT;
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
