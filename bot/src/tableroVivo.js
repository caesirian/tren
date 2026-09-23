// src/tableroVivo.js
// HTML del tablero en tiempo real. Página autocontenida (sin dependencias
// externas), servida por este mismo bot en GET /tablero-vivo. Consulta a
// GET /api/tablero-vivo cada 20s (mismo origen, sin bloqueos de red) y
// redibuja la tabla. El key de la URL (si hay TABLERO_KEY/CHECK_SECRET
// configurada) se reenvía solo a la API.
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
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #0b0f14; color: #e6edf3; }
  header { position: sticky; top: 0; background: #0f151c; border-bottom: 1px solid #1f2937; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; z-index: 5; }
  h1 { font-size: 17px; margin: 0; font-weight: 600; }
  .sub { font-size: 12px; color: #8b98a5; }
  #estado { font-size: 12px; color: #8b98a5; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; vertical-align: 1px; }
  .dot.viejo { background: #f59e0b; }
  .dot.error { background: #ef4444; }
  main { padding: 12px; max-width: 1100px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  thead th { position: sticky; top: 57px; background: #0b0f14; text-align: left; color: #8b98a5; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid #1f2937; white-space: nowrap; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid #161c24; white-space: nowrap; }
  tbody tr:hover { background: #10161d; }
  .num { font-variant-numeric: tabular-nums; color: #9fb0c0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
  .demora-0 { color: #8b98a5; }
  .demora-1 { color: #f2c744; } /* 1-9 min */
  .demora-2 { color: #f59e0b; font-weight: 600; } /* 10-19 */
  .demora-3 { color: #ef4444; font-weight: 700; } /* 20+ */
  .badge.cancel { background: #7f1d1d; color: #fecaca; }
  .badge.origen { background: #3730a3; color: #c7d2fe; }
  .muted { color: #5b6773; }
  #errores { margin: 10px 0 0; font-size: 12px; color: #f59e0b; }
  #vacio { padding: 40px 10px; text-align: center; color: #5b6773; }
  footer { text-align: center; color: #4b5563; font-size: 11px; padding: 20px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>🚆 Sarmiento — tablero en vivo</h1>
    <div class="sub">Datos del proxy de la app de Trenes Argentinos · se actualiza solo cada 20s</div>
  </div>
  <div id="estado"><span class="dot"></span>conectando…</div>
</header>
<main>
  <table>
    <thead>
      <tr><th>Tren</th><th>Origen</th><th>Próxima est.</th><th>Destino</th><th>Prog.</th><th>Estim.</th><th>Demora</th><th>Andén</th><th>Estado</th></tr>
    </thead>
    <tbody id="filas"></tbody>
  </table>
  <div id="vacio" style="display:none">Sin servicios de Sarmiento en este momento.</div>
  <div id="errores"></div>
</main>
<footer>Fuente: proxy no oficial de la app de Trenes Argentinos (ariedro/api-trenes) — no es un dato oficial garantizado.</footer>
<script>
(function () {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  const url = "/api/tablero-vivo" + (key ? "?key=" + encodeURIComponent(key) : "");
  const filas = document.getElementById("filas");
  const vacio = document.getElementById("vacio");
  const estadoEl = document.getElementById("estado");
  const erroresEl = document.getElementById("errores");

  function hhmm(iso) {
    if (!iso) return "—";
    return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  }
  function clip(t, n) { return t && t.length > n ? t.slice(0, n) + "…" : (t || ""); }

  function demoraClase(min) {
    if (min == null) return "demora-0";
    if (min < 1) return "demora-0";
    if (min < 10) return "demora-1";
    if (min < 20) return "demora-2";
    return "demora-3";
  }

  function render(data) {
    filas.innerHTML = "";
    const servicios = data.servicios || [];
    vacio.style.display = servicios.length ? "none" : "block";
    for (const s of servicios) {
      const tr = document.createElement("tr");
      const demTxt = s.cancelado ? "—" : s.demoraMin == null ? "—" : (s.demoraMin >= 0 ? "+" : "") + s.demoraMin + " min";
      tr.innerHTML =
        '<td class="num">#' + (s.numero ?? "?") + '</td>' +
        '<td>' + (s.origen || "—") + (s.origenInusual ? ' <span class="badge origen">inusual</span>' : "") + '</td>' +
        '<td>' + s.proximaEstacion + '</td>' +
        '<td>' + s.destino + '</td>' +
        '<td>' + hhmm(s.prog) + '</td>' +
        '<td>' + hhmm(s.estim) + '</td>' +
        '<td class="' + demoraClase(s.demoraMin) + '">' + demTxt + '</td>' +
        '<td>' + (s.anden || "—") + '</td>' +
        '<td>' + (s.cancelado ? '<span class="badge cancel">CANCELADO' + (s.motivoCancelacion ? ": " + clip(s.motivoCancelacion, 28) : "") + '</span>' : (s.estado || "—")) + '</td>';
      filas.appendChild(tr);
    }
    erroresEl.textContent = data.erroresProxy && data.erroresProxy.length ? "⚠️ " + data.erroresProxy.join(" · ") : "";
  }

  let ultimoOk = 0;
  async function actualizar() {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      render(data);
      ultimoOk = Date.now();
      estadoEl.innerHTML = '<span class="dot"></span>actualizado ' + hhmm(data.consultadoEn);
    } catch (err) {
      const seg = ultimoOk ? Math.round((Date.now() - ultimoOk) / 1000) : null;
      estadoEl.innerHTML = '<span class="dot ' + (seg && seg < 90 ? "viejo" : "error") + '"></span>' +
        (seg ? "sin conexión hace " + seg + "s" : "no pude conectar");
    }
  }

  actualizar();
  setInterval(actualizar, 20000);
})();
</script>
</body>
</html>`;
}
