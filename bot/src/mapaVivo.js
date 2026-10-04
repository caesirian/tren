// src/mapaVivo.js
// Mapa ESQUEMÁTICO (no geográfico) del ramal con dos vías: arriba hacia Moreno,
// abajo hacia Once. La posición de cada formación sale del GPS cuando está
// disponible (t.fuente === "gps") y, si no, se ESTIMA por horarios entre la
// última estación confirmada y la siguiente (t.fuente === "estimada", círculo
// con borde punteado). Misma lógica visual que la sección #mapa-vivo del sitio.
// Página autocontenida, servida por este bot en GET /mapa-vivo.
// Consulta a GET /api/tablero-mapa cada 15s.
import { TRENES, STATIONS as ESTACIONES_SCHEDULE } from "./schedule.js";

// Coordenadas de las 16 estaciones (mismas que STATIONS del sitio), en el orden
// de ids 0 (Once) a 15 (Moreno). Las usa la "Validación de Usuario" para
// proyectar el GPS del celular sobre el ramal. Todo se calcula en el dispositivo.
const COORDS_ESTACIONES = [
  [-34.6083, -58.4103], [-34.6187, -58.4417], [-34.6273, -58.4613], [-34.6307, -58.4807],
  [-34.6313, -58.5003], [-34.6367, -58.5213], [-34.6397, -58.5380], [-34.6433, -58.5617],
  [-34.6448, -58.5830], [-34.6487, -58.6183], [-34.6513, -58.6487], [-34.6583, -58.6717],
  [-34.6647, -58.7030], [-34.6700, -58.7283], [-34.6637, -58.7567], [-34.6503, -58.7917],
];

let htmlCache = null;
export function mapaVivoHTML() {
  if (!htmlCache) {
    const estaciones = ESTACIONES_SCHEDULE.map((e, i) => ({ name: e.name, lat: COORDS_ESTACIONES[i][0], lng: COORDS_ESTACIONES[i][1] }));
    htmlCache = PLANTILLA_HTML
      .replace("__ESTACIONES__", JSON.stringify(estaciones))
      .replace("__TRENES__", JSON.stringify(TRENES));
  }
  return htmlCache;
}

const PLANTILLA_HTML = `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mapa en vivo — Sarmiento</title>
<style>
  :root {
    --navy:#002B5C; --blue:#0055A4; --celeste:#0095D4; --cel-bg:#EEF6FB;
    --text:#1A2C42; --muted:#5A7A99; --border:#CDDAEA; --bg:#F2F7FB; --card:#FFFFFF;
    --green:#15803D; --red:#DC2626; --yellow:#D97706; --yellow-bg:#FEF3C7; --green-bg:#DCFCE7;
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
  .mv-stage.con-mio .mv-tren:not(.mio) { opacity: .3; }
  .mv-tren.mio { width: 34px; height: 34px; margin-left: -17px; z-index: 4; font-size: 11px; box-shadow: 0 0 0 4px #fff, 0 0 0 7px var(--celeste), 0 4px 14px rgba(0,43,92,.45); }
  .mv-tren.mio.ida { top: 19px; }
  .mv-tren.mio.vuelta { top: 79px; }
  .mv-mio-tag { position: absolute; left: 50%; transform: translateX(-50%); padding: 2px 8px; border-radius: 999px; background: var(--celeste); color: #fff; font-size: 10px; font-weight: 800; white-space: nowrap; pointer-events: none; }
  .mv-tren.mio.ida .mv-mio-tag { top: 40px; }
  .mv-tren.mio.vuelta .mv-mio-tag { top: -26px; }
  @media (prefers-reduced-motion: no-preference) { .mv-tren.mio { animation: mvMioPulso 1.8s ease-in-out infinite; } }
  @keyframes mvMioPulso { 0%, 100% { box-shadow: 0 0 0 4px #fff, 0 0 0 7px var(--celeste), 0 4px 14px rgba(0,43,92,.45); } 50% { box-shadow: 0 0 0 4px #fff, 0 0 0 11px rgba(0,149,212,.35), 0 4px 14px rgba(0,43,92,.45); } }
  .mv-mio-panel { background: var(--card); border-radius: 12px; box-shadow: 0 2px 12px rgba(0,43,92,.09); padding: 16px 18px; margin: 12px 16px 0; }
  .mv-mio-titulo { margin: 0 0 4px; font-weight: 800; color: var(--navy); font-size: 15px; }
  .mv-mio-sub { margin: 0 0 12px; font-size: 12.5px; color: var(--muted); }
  .mv-mio-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 12px; align-items: end; }
  .mv-mio-campo label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--muted); }
  .mv-mio-campo select { width: 100%; min-height: 44px; padding: 8px 10px; border: 1.5px solid var(--border); border-radius: 10px; background: #fff; color: var(--text); font: inherit; font-size: 14.5px; }
  .mv-mio-campo select:disabled { background: var(--cel-bg); color: var(--muted); }
  .mv-mio-sentido { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--cel-bg); }
  .mv-mio-sentido button { flex: 1; min-height: 38px; padding: 0 8px; border: 0; border-radius: 999px; background: transparent; color: var(--navy); font: inherit; font-weight: 700; font-size: 13px; cursor: pointer; }
  .mv-mio-sentido button[aria-pressed="true"] { background: var(--navy); color: #fff; }
  .mv-mio-pie { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; margin-top: 10px; }
  .mv-mio-todos { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }
  .mv-mio-quitar { border: 0; background: transparent; color: var(--blue); font: inherit; font-weight: 700; font-size: 13px; text-decoration: underline; cursor: pointer; padding: 6px 2px; }
  .mv-mio-res { margin-top: 10px; padding: 10px 12px; border-radius: 10px; font-size: 14px; font-weight: 600; background: var(--cel-bg); color: var(--navy); }
  .mv-mio-res.ok { background: var(--green-bg); color: var(--green); }
  .mv-mio-res.nada { background: var(--yellow-bg); color: var(--yellow); }
  .mv-mio-debug { display: block; white-space: pre-line; margin-top: 6px; font-weight: 500; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; opacity: .9; word-break: break-word; }
  .mv-val { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 4px 12px 4px 6px; border: 1.5px solid var(--blue); border-radius: 999px; background: #fff; color: var(--blue); font: inherit; font-weight: 700; font-size: 13px; cursor: pointer; }
  .mv-val-ico { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--cel-bg); font-size: 13px; font-weight: 800; line-height: 1; }
  .mv-val.cargando { cursor: progress; opacity: .8; }
  .mv-val.ok { border-color: var(--green); color: var(--green); background: var(--green-bg); cursor: default; }
  .mv-val.ok .mv-val-ico { background: var(--green); color: #fff; font-size: 15px; }
  .mv-val.fail { border-color: var(--yellow); color: var(--yellow); background: var(--yellow-bg); }
  .mv-val.fail .mv-val-ico { background: var(--yellow); color: #fff; font-size: 15px; }
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
<div class="mv-mio-panel" id="mvMio">
  <p class="mv-mio-titulo">📍 ¿Dónde está mi tren?</p>
  <p class="mv-mio-sub">Elegí el sentido en el que viajás, dónde lo tomaste y a qué hora: te marcamos tu formación en el mapa.</p>
  <div class="mv-mio-grid">
    <div class="mv-mio-campo">
      <label id="mvMioSentidoLbl">Sentido</label>
      <div class="mv-mio-sentido" role="group" aria-labelledby="mvMioSentidoLbl">
        <button type="button" data-via="ida" aria-pressed="false">▶ Hacia Moreno</button>
        <button type="button" data-via="vuelta" aria-pressed="false">◀ Hacia Once</button>
      </div>
    </div>
    <div class="mv-mio-campo">
      <label for="mvMioEst">Dónde lo tomaste</label>
      <select id="mvMioEst" disabled><option value="">Elegí primero el sentido</option></select>
    </div>
    <div class="mv-mio-campo">
      <label for="mvMioHora">Horario</label>
      <select id="mvMioHora" disabled><option value="">—</option></select>
    </div>
  </div>
  <div class="mv-mio-pie">
    <label class="mv-mio-todos"><input type="checkbox" id="mvMioTodos"> Mostrar todos los horarios del día</label>
    <button type="button" class="mv-val" id="mvVal" style="display:none;"><span class="mv-val-ico" id="mvValIco" aria-hidden="true">📡</span><span id="mvValTxt">Validación de Usuario</span></button>
    <button type="button" class="mv-mio-quitar" id="mvMioQuitar" style="display:none;">Dejar de seguir mi tren</button>
  </div>
  <div class="mv-mio-res" id="mvMioRes" role="status" aria-live="polite" style="display:none;"></div>
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
  const STATIONS = __ESTACIONES__;
  const TRENES = __TRENES__;
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

  let ultimaData = null;
  function render(data) {
    ultimaData = data;
    const estaciones = data.estaciones || [];
    if (!dibujadas && estaciones.length > 1) dibujarEstaciones(estaciones);
    const n = estaciones.length;
    stage.querySelectorAll(".mv-tren").forEach((x) => x.remove());
    const hacia = { ida: 0, vuelta: 0 };
    const mio = buscarMiTren(data.trenes || []);
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
      if (mio && mio.tren === t) {
        div.classList.add("mio");
        const tag = document.createElement("span");
        tag.className = "mv-mio-tag";
        tag.textContent = "📍 Tu tren" + (validacionOk(mio.tren) ? " ✔" : "");
        div.appendChild(tag);
      }
      stage.appendChild(div);
    });
    stage.classList.toggle("con-mio", !!mio);
    actualizarMio(mio, data);
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

  // ── ¿Dónde está mi tren? ────────────────────────────────────────────────
  // El pasajero indica sentido, estación y horario en que subió. Con eso se identifica el tren en el
  // cronograma oficial (TRENES, tren por tren) y se compara su horario en cada estación con el programado
  // que manda el bot en "paradas" para cada tren en circulación: gana el que mejor coincide.
  const panelMio = document.getElementById("mvMio");
  const resMio = document.getElementById("mvMioRes");
  const quitarMio = document.getElementById("mvMioQuitar");
  const selEst = document.getElementById("mvMioEst");
  const selHora = document.getElementById("mvMioHora");
  const chkTodos = document.getElementById("mvMioTodos");
  const btnVal = document.getElementById("mvVal");
  const btnValIco = document.getElementById("mvValIco");
  const btnValTxt = document.getElementById("mvValTxt");
  const botonesVia = Array.prototype.slice.call(panelMio.querySelectorAll(".mv-mio-sentido button"));
  const FMT_BA = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const FMT_DIA_BA = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short" });
  const LS_MIO = "mvMioSel";
  const TOLERANCIA_MIN = 4;
  let sel = null;          // { via, est, dep }  dep = número de tren elegido en el cronograma
  let viaElegida = null;
  let irAlTren = false;    // centrar el mapa en el tren apenas aparece tras elegir/restaurar
  let validacion = null;   // { estado: "ok" | "fail", numero } — resultado de "Validación de Usuario"
  let validando = false;
  let miTrenActual = null; // tren que hoy coincide con la selección (lo actualiza actualizarMio)

  const dosDig = (n) => String(n).padStart(2, "0");
  function minutosBA(fecha) {
    if (isNaN(fecha)) return NaN;
    const p = FMT_BA.formatToParts(fecha);
    return Number(p.find((x) => x.type === "hour").value) * 60 + Number(p.find((x) => x.type === "minute").value);
  }
  function difMin(a, b) { // a − b en minutos, tomando el camino corto alrededor de la medianoche
    let d = (a - b) % 1440;
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    return d;
  }
  const hhmm = (min) => { const m = ((min % 1440) + 1440) % 1440; return dosDig(Math.floor(m / 60)) + ":" + dosDig(m % 60); };

  // Tipo de día según Buenos Aires (el celular podría tener otra zona horaria).
  function tipoDia(fecha) {
    const w = FMT_DIA_BA.format(fecha);
    return w === "Sun" ? "dom" : w === "Sat" ? "sab" : "lv";
  }
  const getDayType = () => tipoDia(new Date());
  const getPrevDayType = () => tipoDia(new Date(Date.now() - 24 * 60 * 60 * 1000));

  // Trenes del cronograma que pasan por la estación est en el sentido via (hoy, y los de ayer que siguen
  // circulando pasada la medianoche). Cada uno: { n, en } con en = minuto del día en que está en esa estación.
  function trenesEn(via, est) {
    const dir = via === "ida" ? "m" : "o";
    const fuentes = [
      { trenes: TRENES[getDayType()][dir], soloNoche: false },
      { trenes: TRENES[getPrevDayType()][dir], soloNoche: true }
    ];
    const out = [];
    fuentes.forEach((f) => f.trenes.forEach((tr) => {
      const en = tr.t[est];
      if (en == null || (f.soloNoche && en < 1440)) return;
      out.push({ n: tr.n, en: en, t: tr.t });
    }));
    return out;
  }
  // El tren n del cronograma que pasa por est; si hay dos con el mismo número (hoy y ayer), el más cercano a la hora actual.
  function buscarTren(via, n, est) {
    const ahora = minutosBA(new Date());
    let mejor = null;
    trenesEn(via, est).forEach((x) => {
      if (x.n !== n) return;
      const d = Math.abs(difMin(ahora, x.en));
      if (!mejor || d < mejor.d) mejor = { x: x, d: d };
    });
    return mejor ? mejor.x : null;
  }

  function opcion(valor, texto) {
    const o = document.createElement("option");
    o.value = valor;
    o.textContent = texto;
    return o;
  }

  function poblarEstaciones(via, estSel) {
    selEst.innerHTML = "";
    const idxs = [];
    if (via === "ida") { for (let i = 0; i <= 14; i++) idxs.push(i); } else { for (let i = 15; i >= 1; i--) idxs.push(i); }
    idxs.forEach((i) => selEst.appendChild(opcion(String(i), STATIONS[i].name)));
    selEst.value = String(estSel != null ? estSel : idxs[0]);
    selEst.disabled = false;
  }

  function poblarHoras() {
    selHora.innerHTML = "";
    const ahora = minutosBA(new Date());
    const lista = trenesEn(viaElegida, Number(selEst.value)).map((x) => {
      return { dep: x.n, en: x.en, d: difMin(ahora, x.en) };
    }).sort((a, b) => a.en - b.en);
    const reciente = (x) => x.d >= -5 && x.d <= 120;
    const visibles = lista.filter((x) => chkTodos.checked || reciente(x) || (sel && x.dep === sel.dep));
    if (!chkTodos.checked) visibles.sort((a, b) => a.d - b.d); // los más recientes primero
    selHora.appendChild(opcion("", visibles.length ? "Elegí tu horario" : "Sin salidas en las últimas 2 h"));
    visibles.forEach((x) => {
      const rel = !reciente(x) ? "" : x.d > 1 ? " · hace " + x.d + " min" : x.d < -1 ? " · en " + -x.d + " min" : " · ahora";
      selHora.appendChild(opcion(String(x.dep), hhmm(x.en) + rel));
    });
    selHora.disabled = !visibles.length;
    selHora.value = sel ? String(sel.dep) : "";
  }

  function cambiarSeleccion(nueva) {
    sel = nueva;
    validacion = null;
    irAlTren = !!nueva;
    try {
      if (nueva) localStorage.setItem(LS_MIO, JSON.stringify({ via: nueva.via, est: nueva.est, dep: nueva.dep, t: Date.now() }));
      else localStorage.removeItem(LS_MIO);
    } catch (e) { /* sin storage: la selección vive solo en esta visita */ }
    quitarMio.style.display = nueva ? "" : "none";
    if (ultimaData) render(ultimaData); else actualizarMio(null, null);
  }

  function marcarVia(via) {
    botonesVia.forEach((b) => b.setAttribute("aria-pressed", b.getAttribute("data-via") === via ? "true" : "false"));
  }

  // Horario programado de cada tren en circulación vs. el del tren elegido: gana el de menor diferencia (≤ tolerancia).
  function buscarMiTren(trenes) {
    if (!sel) return null;
    const ref = buscarTren(sel.via, sel.dep, sel.est); // el tren elegido, con su horario en cada estación
    if (!ref) return null;
    let mejor = null;
    trenes.forEach((t) => {
      if (viaDe(t) !== sel.via || !Array.isArray(t.paradas)) return;
      const errs = t.paradas
        .filter((p) => p && p.prog && ref.t[p.idx] != null)
        .map((p) => Math.abs(difMin(minutosBA(new Date(p.prog)), ref.t[p.idx])))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (!errs.length) return;
      const err = errs[Math.floor(errs.length / 2)]; // mediana: aguanta una parada con dato raro
      if (err <= TOLERANCIA_MIN && (!mejor || err < mejor.err)) mejor = { tren: t, err: err };
    });
    return mejor;
  }

  function ubicacion(t, nombres) {
    const n = nombres.length;
    if (n < 2) return "";
    const p = Math.min(Math.max(t.posicion, 0), n - 1);
    const i = Math.floor(p), f = p - i;
    const a = nombres[i], b = nombres[Math.min(i + 1, n - 1)];
    if (f < 0.12) return "cerca de " + a;
    if (f > 0.88) return "cerca de " + b;
    return viaDe(t) === "ida" ? "entre " + a + " y " + b : "entre " + b + " y " + a;
  }

  const MODO_DEBUG = params.has("debug"); // ?debug=1 → muestra los datos crudos
  function mostrarRes(clase, texto, debug) {
    resMio.className = "mv-mio-res " + clase;
    resMio.textContent = texto;
    if (MODO_DEBUG && debug) {
      const d = document.createElement("small");
      d.className = "mv-mio-debug";
      d.textContent = debug;
      resMio.appendChild(d);
    }
    resMio.style.display = "";
  }

  function textoFuente(t) {
    return t.fuente === "gps" ? " · 📡 ubicación por GPS" : t.fuente === "estimada" ? " · ≈ ubicación estimada por horarios" : "";
  }

  function textoDebug(t, nombres) {
    const nom = (p) => (nombres[Math.round(p)] || "?") + " (" + p.toFixed(2) + ")";
    const g = t.gps
      ? "GPS " + t.gps.lat.toFixed(5) + ", " + t.gps.long.toFixed(5) + " · a " + t.gps.distEjeM + " m del eje · " + (t.gps.usable ? "usado" : "DESCARTADO (lejos del ramal)") + " → " + nom(t.gps.posicion)
      : "GPS: el proxy no mandó location para este tren";
    const e = typeof t.posicionEstimada === "number" ? "Estimada por horarios → " + nom(t.posicionEstimada) : "Estimada: sin dato";
    const dif = t.gps && typeof t.posicionEstimada === "number" ? " · diferencia GPS vs estimada: " + Math.abs(t.gps.posicion - t.posicionEstimada).toFixed(2) + " estaciones" : "";
    return g + String.fromCharCode(10) + e + dif;
  }

  // ── Validación de Usuario ───────────────────────────────────────────────
  // Compara el GPS del celular con la posición del tren elegido. Todo se hace en el dispositivo:
  // las coordenadas del usuario no se envían a ningún servidor (solo un registro anónimo de precisión). Es una confirmación informal, no segura.
  const MAX_DIST_EJE_VAL_M = 1000;   // más lejos que esto de las vías = no está en el ramal
  const MAX_PRECISION_VAL_M = 1500;  // GPS demasiado impreciso para validar
  const TOL_EST_GPS = 0.5;           // estaciones de diferencia aceptadas si el tren tiene GPS real
  const TOL_EST_ESTIMADA = 1.0;      // idem si su posición es estimada por horarios (menos precisa)

  function validacionOk(t) { return !!(validacion && validacion.estado === "ok" && t && validacion.numero === (t.numero ?? null)); }

  function proyectarRamal(lat, lng) {
    const kx = 111320 * Math.cos((-34.64 * Math.PI) / 180), ky = 110540;
    const px = lng * kx, py = lat * ky;
    let mejor = null;
    for (let i = 0; i < STATIONS.length - 1; i++) {
      const ax = STATIONS[i].lng * kx, ay = STATIONS[i].lat * ky;
      const bx = STATIONS[i + 1].lng * kx, by = STATIONS[i + 1].lat * ky;
      const dx = bx - ax, dy = by - ay;
      const k = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      const distM = Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
      if (!mejor || distM < mejor.distM) mejor = { posicion: i + k, distM: distM };
    }
    return mejor;
  }

  // Devuelve el resultado de comparar el celular con el tren y los datos derivados para el registro
  // (motivo, posición proyectada, distancia al eje, precisión, diferencia). No incluye coordenadas.
  function evaluarValidacion(pos, t) {
    const lat = pos.coords.latitude, lng = pos.coords.longitude, prec = pos.coords.accuracy;
    const base = { ok: false, motivo: "dato_invalido", precisionM: Number.isFinite(prec) ? prec : null };
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !t) return base;
    if (Number.isFinite(prec) && prec > MAX_PRECISION_VAL_M) return Object.assign(base, { motivo: "impreciso" });
    const p = proyectarRamal(lat, lng);
    const tol = t.fuente === "gps" ? TOL_EST_GPS : TOL_EST_ESTIMADA;
    const det = Object.assign(base, { posUsuario: p.posicion, distEjeM: p.distM, tolerancia: tol });
    if (p.distM > MAX_DIST_EJE_VAL_M) return Object.assign(det, { motivo: "lejos_del_ramal" });
    const dif = Math.abs(p.posicion - t.posicion);
    det.difEstaciones = dif;
    return dif <= tol ? Object.assign(det, { ok: true, motivo: "ok" }) : Object.assign(det, { motivo: "distinto_tramo" });
  }

  // Registro de cada intento: se manda al bot (mismo servidor), que lo guarda para medir la precisión de la
  // validación. Solo viajan datos derivados, nunca las coordenadas del celular.
  const API_VALIDACION = "/api/validacion-gps";
  const SESION_VAL = Math.random().toString(36).slice(2, 10); // id al azar por carga de página: agrupa intentos, no identifica a nadie
  function registrarValidacion(tren, det) {
    try {
      const body = {
        sesion: SESION_VAL,
        resultado: det.ok ? "ok" : "fail",
        motivo: det.motivo,
        numero: tren ? tren.numero : null,
        via: sel ? sel.via : null,
        dep: sel ? hhmm(sel.dep) : null,
        destino: tren ? tren.destino : null,
        fuenteTren: tren ? tren.fuente : null,
        posTren: tren && Number.isFinite(tren.posicion) ? tren.posicion : null,
        posUsuario: det.posUsuario, difEstaciones: det.difEstaciones, tolerancia: det.tolerancia,
        distEjeM: det.distEjeM, precisionM: det.precisionM,
        demoraMin: tren ? tren.demoraMax : null,
        pagina: "produccion"
      };
      // text/plain, como en el sitio; keepalive: sale aunque se cierre la página.
      fetch(API_VALIDACION, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), keepalive: true }).catch(function () {});
    } catch (e) { /* el registro nunca debe romper la validación */ }
  }

  function pintarBotonVal() {
    const t = miTrenActual;
    if (!sel || !t || t.cancelado) { btnVal.style.display = "none"; return; }
    btnVal.style.display = "";
    btnVal.classList.remove("ok", "fail", "cargando");
    btnVal.removeAttribute("aria-disabled");
    if (validando) {
      btnVal.classList.add("cargando");
      btnVal.setAttribute("aria-disabled", "true");
      btnValIco.textContent = "…"; btnValTxt.textContent = "Validando posición…";
    } else if (validacionOk(t)) {
      btnVal.classList.add("ok");
      btnVal.setAttribute("aria-disabled", "true");
      btnValIco.textContent = "✔"; btnValTxt.textContent = "Posición validada";
    } else if (validacion && validacion.estado === "fail") {
      btnVal.classList.add("fail");
      btnValIco.textContent = "?"; btnValTxt.textContent = "No se pudo validar posición";
    } else {
      btnValIco.textContent = "📡"; btnValTxt.textContent = "Validación de Usuario";
    }
  }

  function terminarValidacion(det) {
    const tren = miTrenActual;
    validando = false;
    validacion = { estado: det.ok ? "ok" : "fail", numero: tren ? (tren.numero ?? null) : null };
    registrarValidacion(tren, det);
    if (ultimaData) render(ultimaData); else pintarBotonVal();
  }

  function pedirValidacion() {
    if (validando || !miTrenActual || validacionOk(miTrenActual)) return;
    if (!navigator.geolocation) { terminarValidacion({ ok: false, motivo: "sin_geolocalizacion" }); return; }
    validando = true;
    pintarBotonVal();
    navigator.geolocation.getCurrentPosition(
      (pos) => terminarValidacion(evaluarValidacion(pos, miTrenActual)),
      (err) => terminarValidacion({ ok: false, motivo: err && err.code === 1 ? "sin_permiso" : err && err.code === 3 ? "tiempo_agotado" : "gps_no_disponible" }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  }

  function actualizarMio(mio, data) {
    miTrenActual = mio ? mio.tren : null;
    if (validacion && validacion.estado === "ok" && !validacionOk(miTrenActual)) validacion = null; // cambió el tren que coincide: se vuelve a validar
    pintarBotonVal();
    if (!sel) { resMio.style.display = "none"; return; }
    if (!data) { mostrarRes("", "Esperando los datos del mapa…"); return; }
    if (!mio) {
      mostrarRes("nada", "No encontramos en circulación un tren con ese horario. Puede que todavía no haya salido, que ya haya llegado o que esté circulando con otro horario.");
      return;
    }
    const t = mio.tren;
    const dem = t.cancelado ? "cancelado" : t.demoraMax ? "+" + t.demoraMax + " min" : "en horario";
    const prox = !t.cancelado && t.proximaEstacion ? " · próxima: " + t.proximaEstacion : "";
    mostrarRes(t.cancelado ? "nada" : "ok", "📍 Tu formación: #" + (t.numero ?? "?") + " → " + t.destino + " · " + dem + " · " + ubicacion(t, data.estaciones || []) + prox + textoFuente(t), textoDebug(t, data.estaciones || []));
    if (irAlTren) {
      irAlTren = false;
      const el = stage.querySelector(".mv-tren.mio");
      if (el) {
        const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        const suave = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        wrap.scrollBy({ left: r.left - w.left - (w.width - r.width) / 2, behavior: suave ? "smooth" : "auto" });
      }
    }
  }

  function iniciarPanelMio() {
    botonesVia.forEach((b) => b.addEventListener("click", () => {
      viaElegida = b.getAttribute("data-via");
      marcarVia(viaElegida);
      poblarEstaciones(viaElegida);
      cambiarSeleccion(null);
      poblarHoras();
    }));
    selEst.addEventListener("change", () => { cambiarSeleccion(null); poblarHoras(); });
    selHora.addEventListener("change", () => {
      cambiarSeleccion(selHora.value ? { via: viaElegida, est: Number(selEst.value), dep: Number(selHora.value) } : null);
    });
    chkTodos.addEventListener("change", poblarHoras);
    quitarMio.addEventListener("click", () => { cambiarSeleccion(null); poblarHoras(); });
    btnVal.addEventListener("click", pedirValidacion);

    // Si recarga la página mientras viaja, se retoma su tren (válido unas horas y solo si el horario sigue existiendo hoy).
    try {
      const g = JSON.parse(localStorage.getItem(LS_MIO) || "null");
      const estOk = g && (g.via === "ida" ? g.est >= 0 && g.est <= 14 : g.est >= 1 && g.est <= 15);
      if (g && (g.via === "ida" || g.via === "vuelta") && Number.isInteger(g.est) && estOk && Number.isFinite(g.dep) &&
          Date.now() - g.t < 3 * 3600 * 1000 && buscarTren(g.via, g.dep, g.est)) {
        viaElegida = g.via;
        sel = { via: g.via, est: g.est, dep: g.dep };
        irAlTren = true;
        marcarVia(g.via);
        poblarEstaciones(g.via, g.est);
        poblarHoras();
        quitarMio.style.display = "";
        mostrarRes("", "Esperando los datos del mapa…");
      }
    } catch (e) { /* sin storage o dato inválido: se ignora */ }
  }

  iniciarPanelMio();
  actualizar();
  setInterval(actualizar, 15000);
})();
</script>
</body>
</html>`;
