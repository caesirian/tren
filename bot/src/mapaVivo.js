// src/mapaVivo.js
// Mapa ESQUEMÁTICO (no geográfico) del ramal con dos vías: arriba hacia Moreno,
// abajo hacia Once. La posición de cada formación sale del GPS cuando está
// disponible (t.fuente === "gps") y, si no, se ESTIMA por horarios entre la
// última estación confirmada y la siguiente (t.fuente === "estimada", círculo
// con borde punteado). Misma lógica visual que la sección #mapa-vivo del sitio.
// Página autocontenida, servida por este bot en GET /mapa-vivo.
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
    --navy:#002B5C; --blue:#0055A4; --celeste:#0095D4; --cel-bg:#EEF6FB;
    --text:#1A2C42; --muted:#5A7A99; --border:#CDDAEA; --bg:#F2F7FB; --card:#FFFFFF;
    --green:#15803D; --red:#DC2626; --yellow:#D97706; --yellow-bg:#FEF3C7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
  .topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--muted); flex-wrap: wrap; gap: 8px; }
  .topbar strong { color: var(--navy); }
  .saltos { display: flex; gap: 8px; margin: 12px 16px 0; }
  .saltos button { flex: 1; min-height: 40px; border: 1.5px solid var(--blue); border-radius: 999px; background: #fff; color: var(--blue); font: inherit; font-weight: 700; font-size: 13px; cursor: pointer; }
  .aviso { margin: 12px 16px 0; padding: 10px 14px; background: var(--yellow-bg); color: #8a5a00; border-radius: 10px; font-size: 12px; }
  .leyenda { display: flex; gap: 14px; flex-wrap: wrap; padding: 0 16px; font-size: 11.5px; color: var(--muted); margin-top: 10px; }
  .leyenda span { display: inline-flex; align-items: center; gap: 5px; }
  .leyenda i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .mv-wrap { margin: 12px 16px 16px; background: var(--card); border-radius: 12px; box-shadow: 0 2px 12px rgba(0,43,92,.09); padding: 24px 20px 90px; overflow-x: auto; }
  .mv-stage { position: relative; min-width: 1000px; height: 130px; margin: 0 100px 0 30px; }
  .mv-via { position: absolute; left: -12px; right: -12px; height: 12px; border-radius: 6px; background-repeat: repeat-x; background-position: 0 center; }
  .mv-via.ida { top: 30px; background-color: var(--celeste); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='12'%3E%3Cpath d='M8 2.5l3.5 3.5L8 9.5' fill='none' stroke='%23ffffff' stroke-opacity='.85' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
  .mv-via.vuelta { top: 90px; background-color: var(--navy); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='12'%3E%3Cpath d='M14 2.5L10.5 6l3.5 3.5' fill='none' stroke='%23ffffff' stroke-opacity='.85' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
  .mv-etiqueta { position: absolute; left: -12px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 800; color: #fff; white-space: nowrap; }
  .mv-etiqueta.ida { top: 2px; background: var(--celeste); }
  .mv-etiqueta.vuelta { top: 62px; background: var(--navy); }
  .mv-estacion { position: absolute; top: 0; width: 0; height: 130px; }
  .mv-estacion .mv-linea { position: absolute; left: -1px; top: 40px; width: 2px; height: 50px; background: var(--border); }
  .mv-estacion .mv-punto { position: absolute; left: -8px; width: 16px; height: 16px; border-radius: 50%; background: var(--card); border: 3px solid var(--blue); box-sizing: border-box; }
  .mv-estacion .mv-punto.ida { top: 28px; }
  .mv-estacion .mv-punto.vuelta { top: 88px; }
  .mv-estacion .mv-nombre { position: absolute; top: 112px; left: 0; transform-origin: top left; transform: rotate(45deg); font-size: 10px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .mv-estacion.cabecera .mv-nombre { color: var(--navy); font-weight: 800; font-size: 11px; }
  .mv-tren { position: absolute; min-width: 36px; height: 24px; padding: 0 6px; transform: translateX(-50%); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; color: #fff; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,43,92,.3); transition: left 1s linear; z-index: 2; }
  .mv-tren.ida { top: 24px; }
  .mv-tren.vuelta { top: 84px; }
  .mv-tren.ok { background: var(--green); }
  .mv-tren.demorado { background: var(--yellow); }
  .mv-tren.muy-demorado { background: var(--red); }
  .mv-tren.cancelado { background: #9CA3AF; }
  .mv-tren.est { border-style: dashed; }
  .mv-tren.origen-inusual { outline: 3px solid #4338CA; outline-offset: 1px; }
  .mv-tren .mv-tip { position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%); background: var(--navy); color: #fff; padding: 5px 9px; border-radius: 8px; font-size: 11px; white-space: nowrap; display: none; font-weight: 600; pointer-events: none; z-index: 5; }
  .mv-tren:hover .mv-tip, .mv-tren:focus .mv-tip { display: block; }
  .mv-vacio { position: absolute; left: 0; right: 0; text-align: center; font-size: 12px; color: var(--muted); font-weight: 600; }
  .mv-vacio.ida { top: 48px; }
  .mv-vacio.vuelta { top: 108px; }
  footer.credito { text-align: center; color: #9AA9B8; font-size: 11px; padding: 0 16px 16px; }
</style>
</head>
<body>
<div class="topbar">
  <span>🗺️ <strong>Sarmiento</strong> — mapa en vivo</span>
  <span id="estado">conectando…</span>
</div>
<div class="saltos">
  <button type="button" id="irOnce">◀ Ir a Once</button>
  <button type="button" id="irMoreno">Ir a Moreno ▶</button>
</div>
<div class="aviso">📡 La posición sale del GPS de la formación cuando está disponible. Si no, se ESTIMA por horarios entre la última estación confirmada y la siguiente (círculo con borde punteado) y puede estar corrida, sobre todo con demoras grandes.</div>
<div class="leyenda">
  <span><i style="background:var(--green)"></i> en horario</span>
  <span><i style="background:var(--yellow)"></i> demorado</span>
  <span><i style="background:var(--red)"></i> muy demorado</span>
  <span><i style="background:#9CA3AF"></i> cancelado</span>
  <span><i style="background:transparent;border:2px solid #4338CA"></i> origen inusual</span>
  <span><i style="background:var(--green);border:2px dashed #fff;box-shadow:0 0 0 1px var(--muted)"></i> posición estimada (sin GPS)</span>
</div>
<div class="mv-wrap" id="wrap">
  <div class="mv-stage" id="stage">
    <div class="mv-via ida"></div>
    <div class="mv-via vuelta"></div>
    <span class="mv-etiqueta ida">▶ Hacia Moreno</span>
    <span class="mv-etiqueta vuelta">◀ Hacia Once</span>
    <div class="mv-vacio ida" id="vacioIda" style="display:none;">Sin formaciones hacia Moreno en este momento</div>
    <div class="mv-vacio vuelta" id="vacioVuelta" style="display:none;">Sin formaciones hacia Once en este momento</div>
  </div>
</div>
<footer class="credito">Vía de arriba: hacia Moreno ▶ · vía de abajo: hacia Once ◀. Datos no oficiales: pueden tener desfasajes.</footer>
<script>
(function () {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  const wrap = document.getElementById("wrap");
  const stage = document.getElementById("stage");
  const estadoEl = document.getElementById("estado");
  const vacioIda = document.getElementById("vacioIda");
  const vacioVuelta = document.getElementById("vacioVuelta");

  function urlApi() {
    return "/api/tablero-mapa" + (key ? "?key=" + encodeURIComponent(key) : "");
  }

  function claseDemora(t) {
    if (t.cancelado) return "cancelado";
    if (t.demoraMax >= 20) return "muy-demorado";
    if (t.demoraMax >= 10) return "demorado";
    return "ok";
  }

  // "ida" = hacia Moreno (vía de arriba); "vuelta" = hacia Once (vía de abajo).
  function viaDe(t) {
    const d = (t.destino || "").toLowerCase();
    if (d.indexOf("once") !== -1) return "vuelta";
    if (d.indexOf("moreno") !== -1) return "ida";
    return t.sentido === "Moreno-Once" ? "vuelta" : "ida";
  }

  let dibujadas = false;
  function dibujarEstaciones(nombres) {
    stage.querySelectorAll(".mv-estacion").forEach((n) => n.remove());
    const n = nombres.length;
    nombres.forEach((nombre, i) => {
      const div = document.createElement("div");
      div.className = "mv-estacion" + (i === 0 || i === n - 1 ? " cabecera" : "");
      div.style.left = (i / (n - 1)) * 100 + "%";
      div.innerHTML = '<span class="mv-linea"></span><span class="mv-punto ida"></span><span class="mv-punto vuelta"></span><span class="mv-nombre"></span>';
      div.querySelector(".mv-nombre").textContent = nombre;
      stage.appendChild(div);
    });
    dibujadas = true;
  }

  function render(data) {
    const estaciones = data.estaciones || [];
    if (!dibujadas && estaciones.length > 1) dibujarEstaciones(estaciones);
    const n = estaciones.length;
    stage.querySelectorAll(".mv-tren").forEach((x) => x.remove());
    const hacia = { ida: 0, vuelta: 0 };
    (data.trenes || []).forEach((t) => {
      if (n < 2) return;
      const via = viaDe(t);
      hacia[via]++;
      const div = document.createElement("div");
      div.className = "mv-tren " + via + " " + claseDemora(t) + (t.origenInusual ? " origen-inusual" : "") + (t.fuente === "estimada" ? " est" : "");
      div.tabIndex = 0;
      div.style.left = (t.posicion / (n - 1)) * 100 + "%";
      div.textContent = t.numero ?? "";
      const dem = t.cancelado ? "Cancelado" : t.demoraMax ? "+" + t.demoraMax + " min" : "en horario";
      const inusual = t.origenInusual ? " · ⚠ origen inusual" : "";
      const tip = document.createElement("span");
      tip.className = "mv-tip";
      tip.textContent = "#" + (t.numero ?? "?") + " → " + t.destino + " · " + dem + inusual + (t.fuente === "gps" ? " · 📡 GPS" : t.fuente === "estimada" ? " · ≈ estimada" : "");
      div.appendChild(tip);
      stage.appendChild(div);
    });
    vacioIda.style.display = hacia.ida ? "none" : "block";
    vacioVuelta.style.display = hacia.vuelta ? "none" : "block";
    const hora = data.consultadoEn ? new Date(data.consultadoEn).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "";
    estadoEl.textContent = "🕐 " + hora + " · " + hacia.ida + " hacia Moreno · " + hacia.vuelta + " hacia Once";
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
      estadoEl.textContent = seg ? "🕐 sin conexión hace " + seg + "s" : "🕐 no se pudo conectar";
    }
  }

  document.getElementById("irOnce").addEventListener("click", () => wrap.scrollTo({ left: 0, behavior: "smooth" }));
  document.getElementById("irMoreno").addEventListener("click", () => wrap.scrollTo({ left: wrap.scrollWidth, behavior: "smooth" }));

  actualizar();
  setInterval(actualizar, 15000);
})();
</script>
</body>
</html>`;
}
