// src/mapaVivo.js
// Mapa ESQUEMÁTICO (no geográfico) del ramal: las 16 estaciones en línea y
// los trenes como puntos, ubicados por INTERPOLACIÓN DE TIEMPO entre la
// última estación confirmada y la siguiente (no hay GPS real confirmado en
// el proxy). Es una aproximación, más floja cuanto más demorado viene el
// tren. Página autocontenida, servida por este bot en GET /mapa-vivo.
// Consulta a GET /api/tablero-mapa cada 15s.
export function mapaVivoHTML() {
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mapa en vivo — Sarmiento</title>
<style>
  :root {
    --navy:#002B5C; --blue:#0055A4; --celeste:#0095D4; --cel-light:#D6EDF7; --cel-bg:#EEF6FB;
    --text:#1A2C42; --muted:#5A7A99; --border:#CDDAEA; --bg:#F2F7FB; --card:#FFFFFF;
    --green:#15803D; --red:#DC2626; --yellow:#D97706;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
  .topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--muted); flex-wrap: wrap; gap: 8px; }
  .aviso { margin: 12px 16px 0; padding: 10px 14px; background: #FFF7E6; color: #8a5a00; border: 1px solid #f0d99a; border-radius: 10px; font-size: 12px; }
  .mapa-wrap { margin: 16px; background: var(--card); border-radius: 14px; box-shadow: 0 4px 18px rgba(0,43,92,.1); padding: 40px 24px 60px; overflow-x: auto; }
  .track { position: relative; min-width: 1100px; height: 6px; background: var(--border); border-radius: 4px; margin: 0 30px; }
  .estacion { position: absolute; top: -5px; width: 16px; height: 16px; border-radius: 50%; background: var(--card); border: 3px solid var(--celeste); transform: translateX(-50%); }
  .estacion .nombre { position: absolute; top: 18px; left: 50%; transform: translateX(-50%) rotate(45deg); transform-origin: top left; font-size: 10.5px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .tren { position: absolute; top: -13px; width: 24px; height: 24px; border-radius: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #fff; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,.25); cursor: default; transition: left 1s linear; }
  .tren.ok { background: var(--green); }
  .tren.demorado { background: var(--yellow); }
  .tren.muy-demorado { background: var(--red); }
  .tren.cancelado { background: #9CA3AF; }
  .tren .tip { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); background: var(--navy); color: #fff; padding: 6px 9px; border-radius: 8px; font-size: 11px; white-space: nowrap; display: none; font-weight: 600; pointer-events: none; z-index: 5; }
  .tren:hover .tip { display: block; }
  .leyenda { display: flex; gap: 16px; flex-wrap: wrap; padding: 0 16px; font-size: 11.5px; color: var(--muted); margin-top: 4px; }
  .leyenda span { display: inline-flex; align-items: center; gap: 5px; }
  .leyenda i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  footer.credito { text-align: center; color: #9AA9B8; font-size: 11px; padding: 16px; }
</style>
</head>
<body>
<div class="topbar">
  <span>🗺️ Sarmiento — mapa esquemático en vivo</span>
  <span id="estado">conectando…</span>
</div>
<div class="aviso">⚠️ Posición ESTIMADA por horarios, no es GPS real: se calcula entre la última estación confirmada y la siguiente. Puede estar corrida, sobre todo con demoras grandes.</div>
<div class="leyenda">
  <span><i style="background:var(--green)"></i> en horario</span>
  <span><i style="background:var(--yellow)"></i> demorado</span>
  <span><i style="background:var(--red)"></i> muy demorado</span>
  <span><i style="background:#9CA3AF"></i> cancelado</span>
</div>
<div class="mapa-wrap"><div class="track" id="track"></div></div>
<footer class="credito">Fuente: proxy no oficial de la app de Trenes Argentinos (ariedro/api-trenes) — no es un dato oficial garantizado. Once queda a la izquierda, Moreno a la derecha.</footer>
<script>
(function () {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  const track = document.getElementById("track");
  const estadoEl = document.getElementById("estado");

  function urlApi() {
    const qs = new URLSearchParams();
    if (key) qs.set("key", key);
    return "/api/tablero-mapa" + (key ? "?" + qs.toString() : "");
  }

  function claseDemora(t) {
    if (t.cancelado) return "cancelado";
    if (t.demoraMax >= 20) return "muy-demorado";
    if (t.demoraMax >= 10) return "demorado";
    return "ok";
  }

  let dibujadas = false;
  function dibujarEstaciones(nombres) {
    track.querySelectorAll(".estacion").forEach((n) => n.remove());
    const n = nombres.length;
    nombres.forEach((nombre, i) => {
      const div = document.createElement("div");
      div.className = "estacion";
      div.style.left = (i / (n - 1)) * 100 + "%";
      div.innerHTML = '<span class="nombre">' + nombre + '</span>';
      track.appendChild(div);
    });
    dibujadas = true;
  }

  function render(data) {
    if (!dibujadas) dibujarEstaciones(data.estaciones || []);
    const n = (data.estaciones || []).length;
    track.querySelectorAll(".tren").forEach((n) => n.remove());
    (data.trenes || []).forEach((t) => {
      const div = document.createElement("div");
      div.className = "tren " + claseDemora(t);
      div.style.left = (t.posicion / (n - 1)) * 100 + "%";
      div.textContent = t.numero ?? "";
      const dem = t.cancelado ? "Cancelado" : t.demoraMax ? "+" + t.demoraMax + " min" : "en horario";
      div.innerHTML += '<span class="tip">#' + (t.numero ?? "?") + ' → ' + t.destino + ' · ' + dem + '</span>';
      track.appendChild(div);
    });
    estadoEl.textContent = "actualizado " + (data.consultadoEn ? new Date(data.consultadoEn).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "") + " · " + (data.trenes || []).length + " formaciones";
  }

  let ultimoOk = 0;
  async function actualizar() {
    try {
      const res = await fetch(urlApi(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      render(data);
      ultimoOk = Date.now();
    } catch (err) {
      const seg = ultimoOk ? Math.round((Date.now() - ultimoOk) / 1000) : null;
      estadoEl.textContent = seg ? "sin conexión hace " + seg + "s" : "no pude conectar";
    }
  }

  actualizar();
  setInterval(actualizar, 15000);
})();
</script>
</body>
</html>`;
}
