/* mapa-vivo.js · v1 — Mapa vertical en vivo del ramal Once–Moreno.
 *
 * ÚNICO código del mapa: lo cargan la web (index.html), la app (lite/) y la página de Render (/mapa-vivo).
 * Un cambio acá se ve en los tres. Lo propio de cada lugar (panel "¿Dónde está mi tren?", pestañas, etc.)
 * se conecta por `hooks`; el mapa no sabe nada de eso.
 *
 *   var mapa = MapaVivo.crear({
 *     contenedor,   // elemento vacío donde se dibuja el mapa
 *     api,          // URL de /api/tablero-mapa → el mapa consulta solo. Sin api: el anfitrión llama a mapa.pintar(datos)
 *     estadoEl,     // (opcional) elemento donde se escribe el estado de la consulta (solo con api)
 *     clave,        // (opcional) clave de localStorage para recordar "mi tren" por número (sin hooks.mio)
 *     resumen,      // (opcional) true: tira "Tu tren …" arriba del mapa (solo con "mi tren" propio)
 *     barraAbajo,   // (opcional) separación inferior de la barra flotante (ej. para quedar sobre una barra de pestañas)
 *     activo,       // (opcional) función → false si el mapa no está a la vista (pestañas)
 *     hooks: {      // (todos opcionales)
 *       mio(datos) → { tren, err } | null   // cuál es "mi tren" (por defecto: el guardado por número en `clave`)
 *       esMio(t), marcar(t, via), quitar(),  // acciones de la barra al tocar una formación
 *       etiqueta(t) → texto extra de "Tu tren", despues(datos, mio)  // después de cada pintada
 *     }
 *   });
 *   mapa.iniciar();   // con api: empieza a consultar
 *   → pintar(datos) · refrescar() · datos() · seguir([bool]) · centrarMio(suave) · mio()
 */
(function (global) {
  "use strict";
  if (global.MapaVivo) return;
  var VERSION = 2, FILA = 48, CAB = 40, GAP = 28, MAX_V = 0.012, HORIZ_S = 45;

  var CSS = [
    ".mv{position:relative;background:var(--card,#fff);border:1px solid var(--border,#CDDAEA);border-radius:16px;padding:6px 0;box-shadow:0 2px 12px rgba(0,43,92,.07);--mv-local:var(--fucsia,#C026D3)}",
    ".mv-mibarra{display:none;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;margin:6px 8px 8px;padding:10px 12px;border:1px solid var(--border,#CDDAEA);border-radius:12px;font-size:13px;font-weight:600;color:var(--navy,#002B5C)}",
    ".mv-mibarra.on{display:flex}",
    ".mv-mibarra button{min-height:36px;padding:0 10px;border:0;background:transparent;color:var(--blue,#0055A4);font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}",
    ".mv-stage{position:relative;max-width:440px;height:760px;margin:0 auto}",
    ".mv-etiqueta{position:absolute;top:8px;width:48px;text-align:center;line-height:1.15;font-size:10px;font-weight:800;color:var(--muted,#5B6B82);text-transform:uppercase;letter-spacing:.4px}",
    ".mv-etiqueta.vuelta{left:4px}.mv-etiqueta.ida{left:52px}",
    ".mv-vacio{position:absolute;left:112px;right:6px;font-size:11px;font-weight:600;color:var(--muted,#5B6B82)}",
    ".mv-vacio.ida{top:4px}.mv-vacio.vuelta{top:20px}",
    ".mv-via{position:absolute;top:40px;width:4px;margin-left:-2px;border-radius:2px;background:#E1EAF3}",
    ".mv-via.vuelta{left:28px}.mv-via.ida{left:76px}",
    ".mv-estacion{position:absolute;left:0;right:0;height:0}",
    ".mv-punto{position:absolute;top:-9px;width:18px;height:18px;box-sizing:border-box;border-radius:50%;background:#fff;border:3px solid var(--blue,#0055A4)}",
    ".mv-punto.vuelta{left:19px}.mv-punto.ida{left:67px}",
    ".mv-estacion.cabecera .mv-punto{border-color:var(--navy,#002B5C);background:var(--navy,#002B5C)}",
    ".mv-nombre{position:absolute;left:112px;top:-10px;font-size:14px;line-height:20px;color:var(--text,#0F2A47);white-space:nowrap}",
    ".mv-estacion.cabecera .mv-nombre{font-weight:800;color:var(--navy,#002B5C)}",
    ".mv-tren{position:absolute;width:46px;height:26px;margin:-13px 0 0 0;padding:0;border-radius:13px;border:2px solid #fff;box-sizing:border-box;color:#fff;font:800 11px/22px ui-monospace,Menlo,Consolas,monospace;text-align:center;box-shadow:0 2px 6px rgba(0,43,92,.35);will-change:top;z-index:3;cursor:pointer;background:var(--green,#16A34A)}",
    ".mv-tren.vuelta{left:5px}.mv-tren.ida{left:53px}",
    ".mv-tren.ok{background:var(--green,#16A34A)}.mv-tren.demorado{background:var(--yellow,#F59E0B)}.mv-tren.muy-demorado{background:var(--red,#DC2626)}.mv-tren.cancelado{background:#6B7280}",
    ".mv-tren.local{background:var(--mv-local)}.mv-tren.est{opacity:.78;border-style:dashed}",
    ".mv-tren.origen-inusual{outline:3px solid #4338CA;outline-offset:1px}",
    ".mv-tren.sel{outline:3px solid var(--navy,#002B5C);outline-offset:2px}",
    ".mv-tip{position:absolute;top:50%;left:calc(100% + 6px);transform:translateY(-50%);background:var(--navy,#002B5C);color:#fff;padding:5px 9px;border-radius:8px;font:600 11px/1.2 system-ui,sans-serif;text-align:left;white-space:nowrap;display:none;pointer-events:none;z-index:6}",
    ".mv-tren:hover .mv-tip,.mv-tren:focus .mv-tip{display:block}",
    ".mv-stage.con-mio .mv-tren:not(.mio){opacity:.3}",
    ".mv-tren.mio{z-index:5;opacity:1;box-shadow:0 0 0 3px #fff,0 0 0 6px var(--celeste,#0095D4),0 3px 10px rgba(0,43,92,.45)}",
    "@media (prefers-reduced-motion:no-preference){.mv-tren.mio{animation:mvPulso 1.8s ease-in-out infinite}}",
    "@keyframes mvPulso{0%,100%{box-shadow:0 0 0 3px #fff,0 0 0 6px var(--celeste,#0095D4),0 3px 10px rgba(0,43,92,.45)}50%{box-shadow:0 0 0 3px #fff,0 0 0 10px rgba(0,149,212,.35),0 3px 10px rgba(0,43,92,.45)}}",
    ".mv-mio-tag{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);padding:2px 8px;border-radius:999px;background:var(--celeste,#0095D4);color:#fff;font:800 10.5px/1.3 system-ui,sans-serif;white-space:nowrap;pointer-events:none}",
    ".mv-accion{display:none;position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:min(92vw,520px);box-sizing:border-box;z-index:1200;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;padding:12px 14px;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,43,92,.3);font-size:13.5px;font-weight:600;color:#002B5C}",
    ".mv-accion.on{display:flex}",
    ".mv-accion button,.mv-seguir{min-height:40px;padding:0 14px;border:0;border-radius:999px;background:#0095D4;color:#fff;font:inherit;font-weight:800;cursor:pointer}",
    ".mv-accion button.sec{background:transparent;color:#0055A4;text-decoration:underline;padding:0 4px}",
    ".mv-seguir{display:none;position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:1199;box-shadow:0 4px 16px rgba(0,43,92,.3)}",
    ".mv-seguir.on{display:block}"
  ].join("\n");

  function inyectarCSS() {
    if (document.getElementById("mv-css")) return;
    var st = document.createElement("style"); st.id = "mv-css"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  function esc(x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bonito(n) { return n === "Padua" ? "San A. de Padua" : n; }
  // "ida" = hacia Moreno (baja por el mapa); "vuelta" = hacia Once (sube).
  function viaDe(t) {
    var d = (t.destino || "").toLowerCase();
    if (d.indexOf("once") !== -1) return "vuelta";
    if (d.indexOf("moreno") !== -1) return "ida";
    return t.sentido === "Moreno-Once" ? "vuelta" : "ida";
  }
  function claseDemora(t) {
    if (t.cancelado) return "cancelado";
    if (t.demoraMax >= 20) return "muy-demorado";
    if (t.demoraMax >= 10) return "demorado";
    return "ok";
  }
  function separar(L, min, max) {
    var n = L.length, i, it;
    if (n < 2) return;
    for (it = 0; it < 8; it++) {
      var movio = false;
      for (i = 1; i < n; i++) {
        var d = L[i].y - L[i - 1].y;
        if (d < GAP) { var m = (GAP - d) / 2; L[i - 1].y -= m; L[i].y += m; movio = true; }
      }
      if (!movio) break;
    }
    if (L[0].y < min) { L[0].y = min; for (i = 1; i < n; i++) L[i].y = Math.max(L[i].y, L[i - 1].y + GAP); }
    if (L[n - 1].y > max) { L[n - 1].y = max; for (i = n - 2; i >= 0; i--) L[i].y = Math.min(L[i].y, L[i + 1].y - GAP); }
  }
  function demTxt(t) { return t.cancelado ? "cancelado" : t.demoraMax ? "+" + t.demoraMax + " min" : "en horario"; }

  function crear(o) {
    o = o || {};
    var hooks = o.hooks || {};
    var raiz = o.contenedor;
    if (!raiz) throw new Error("MapaVivo: falta el contenedor");
    inyectarCSS();
    raiz.classList.add("mv");
    raiz.innerHTML = '<div class="mv-mibarra" role="status" aria-live="polite"></div><div class="mv-stage">' +
      '<div class="mv-via ida"></div><div class="mv-via vuelta"></div>' +
      '<span class="mv-etiqueta vuelta">▲ A Once</span><span class="mv-etiqueta ida">▼ A Moreno</span>' +
      '<div class="mv-vacio ida" style="display:none">Sin formaciones hacia Moreno ahora</div>' +
      '<div class="mv-vacio vuelta" style="display:none">Sin formaciones hacia Once ahora</div></div>';
    var stage = raiz.querySelector(".mv-stage"), barraMio = raiz.querySelector(".mv-mibarra");
    var vacio = { ida: raiz.querySelector(".mv-vacio.ida"), vuelta: raiz.querySelector(".mv-vacio.vuelta") };
    var barra = document.createElement("div"); barra.className = "mv-accion"; barra.setAttribute("aria-live", "polite");
    var pill = document.createElement("button"); pill.type = "button"; pill.className = "mv-seguir"; pill.textContent = "📍 Seguir mi tren";
    if (o.barraAbajo) { barra.style.bottom = o.barraAbajo; pill.style.bottom = o.barraAbajo; }
    document.body.appendChild(barra); document.body.appendChild(pill);

    var datos = null, T = new Map(), elegida = null, mioT = null, mioObj = null, sigue = true, nEst = 0;
    var dibujadas = false, sigBarra = "", sigMio = "", pillOn = false, ultimoFrame = performance.now();
    var base = "", ultimoOk = 0, fallas = 0, enCurso = false, timer = null, arrancado = false;

    // ── "Mi tren" propio (si el anfitrión no trae el suyo): se recuerda por número de formación, 3 h ──
    function leerPin() {
      if (!o.clave) return null;
      try { var g = JSON.parse(localStorage.getItem(o.clave) || "null"); if (g && (g.via === "ida" || g.via === "vuelta") && g.num != null && Date.now() - g.t < 3 * 3600 * 1000) return g; } catch (e) {}
      return null;
    }
    var pin = leerPin();
    function esPin(t) { return !!(pin && t && t.numero != null && viaDe(t) === pin.via && String(t.numero) === String(pin.num)); }
    function buscarMio(d) {
      if (hooks.mio) return hooks.mio(d) || null;
      var tr = d.trenes || [];
      for (var i = 0; i < tr.length; i++) if (esPin(tr[i])) return { tren: tr[i], err: 0 };
      return null;
    }
    function esMio(t) { return hooks.esMio ? !!hooks.esMio(t) : esPin(t); }
    function marcar(t, via) {
      if (hooks.marcar) hooks.marcar(t, via);
      else { pin = { num: String(t.numero), via: via, t: Date.now() }; try { localStorage.setItem(o.clave, JSON.stringify(pin)); } catch (e) {} sigue = true; }
      refrescar();
    }
    function quitar() {
      if (hooks.quitar) hooks.quitar();
      else { pin = null; try { localStorage.removeItem(o.clave); } catch (e) {} }
      refrescar();
    }

    function dibujar(est) {
      nEst = est.length;
      Array.prototype.forEach.call(stage.querySelectorAll(".mv-estacion"), function (x) { x.remove(); });
      est.forEach(function (nom, i) {
        var d = document.createElement("div");
        d.className = "mv-estacion" + (i === 0 || i === nEst - 1 ? " cabecera" : "");
        d.style.top = (CAB + i * FILA) + "px";
        d.innerHTML = '<span class="mv-punto vuelta"></span><span class="mv-punto ida"></span><span class="mv-nombre"></span>';
        d.querySelector(".mv-nombre").textContent = bonito(nom);
        stage.appendChild(d);
      });
      stage.style.height = (CAB + (nEst - 1) * FILA + 24) + "px";
      Array.prototype.forEach.call(stage.querySelectorAll(".mv-via"), function (v) { v.style.height = ((nEst - 1) * FILA) + "px"; });
      dibujadas = true;
    }

    // ── Movimiento: entre consulta y consulta se extrapola con la velocidad observada (tope HORIZ_S) y la
    // posición mostrada se acerca suave a la prevista: sin saltos ni transiciones CSS fijas. ──
    function fijarObjetivo(e, t, via, tData) {
      var p = Math.min(Math.max(Number(t.posicion) || 0, 0), nEst - 1);
      var dir = via === "ida" ? 1 : -1, dt = (tData - e.tData) / 1000;
      if (e.pos !== null && dt > 0.5) { // solo con una muestra nueva (no el mismo dato en caché)
        var v = t.cancelado ? 0 : Math.min(Math.max(((p - e.pos) / dt) * dir, 0), MAX_V);
        e.v = e.v * 0.5 + v * 0.5;
      }
      if (e.pos === null || dt > 0.5) { e.pos = p; e.t0 = performance.now(); e.tData = tData; }
      if (e.disp === null) { e.disp = p; e.el.style.top = (CAB + p * FILA) + "px"; }
      else if (Math.abs(e.disp - p) > 1.5) e.disp = p; // salto grande: ubicar directo
      e.faltas = 0;
    }
    function enPantalla() { var r = stage.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }
    function cuadro(now) {
      var dt = Math.min((now - ultimoFrame) / 1000, 0.25);
      ultimoFrame = now;
      if (datos && nEst > 1 && !document.hidden && (!o.activo || o.activo())) {
        var vias = { ida: [], vuelta: [] };
        T.forEach(function (e) {
          var dir = e.via === "ida" ? 1 : -1, edad = Math.min((now - e.t0) / 1000, HORIZ_S);
          var pred = Math.min(Math.max(e.pos + dir * e.v * edad, 0), nEst - 1);
          var d = e.disp + (pred - e.disp) * (1 - Math.exp(-dt / 1.5));
          if ((d - e.disp) * dir < 0 && Math.abs(pred - e.disp) < 0.5) d = e.disp; // no retrocede por ruido
          e.disp = d;
          vias[e.via].push({ e: e, y: CAB + d * FILA });
        });
        ["ida", "vuelta"].forEach(function (v) {
          var L = vias[v].sort(function (a, b) { return a.y - b.y; });
          separar(L, CAB, CAB + (nEst - 1) * FILA); // formaciones muy juntas en una misma vía no se pisan
          L.forEach(function (x) { x.e.el.style.top = x.y + "px"; });
        });
        var vis = enPantalla();
        var el = sigue && mioT && vis ? stage.querySelector(".mv-tren.mio") : null;
        if (el) { // seguimiento: la pantalla acompaña a tu formación (solo mientras el mapa está a la vista)
          var r = el.getBoundingClientRect(), dy = r.top + r.height / 2 - window.innerHeight / 2;
          if (Math.abs(dy) > 3) window.scrollBy({ top: dy * (1 - Math.exp(-dt / 0.4)), behavior: "instant" });
        }
        var pon = !!mioT && !sigue && vis && !barra.classList.contains("on");
        if (pon !== pillOn) { pillOn = pon; pill.classList.toggle("on", pon); }
      } else if (pillOn) { pillOn = false; pill.classList.remove("on"); }
      requestAnimationFrame(cuadro);
    }

    function ubicacion(t) {
      var p = Math.min(Math.max(t.posicion, 0), nEst - 1), k = Math.floor(p), f = p - k;
      var a = bonito(datos.estaciones[k]), b = bonito(datos.estaciones[Math.min(k + 1, nEst - 1)]);
      return f < 0.12 ? "cerca de " + a : f > 0.88 ? "cerca de " + b : viaDe(t) === "ida" ? "entre " + a + " y " + b : "entre " + b + " y " + a;
    }
    function pintarResumen() {
      if (!o.resumen || hooks.mio) { barraMio.className = "mv-mibarra"; return; }
      if (!pin) { barraMio.className = "mv-mibarra"; sigMio = ""; return; }
      var txt = mioT
        ? "📍 <b>Tu tren #" + esc(mioT.numero) + "</b> → " + esc(bonito(mioT.destino || "?")) + " · " + demTxt(mioT) + " · " + ubicacion(mioT) + (mioT.proximaEstacion && !mioT.cancelado ? " · próxima: " + esc(bonito(mioT.proximaEstacion)) : "")
        : "📍 <b>Tu tren #" + esc(pin.num) + "</b>: no lo encontramos en circulación (puede que todavía no haya salido o que ya haya llegado).";
      barraMio.className = "mv-mibarra on";
      if (txt === sigMio) return;
      sigMio = txt;
      barraMio.innerHTML = "<span>" + txt + '</span><button type="button">Dejar de seguir</button>';
    }
    function pintarBarra() {
      var e = elegida ? T.get(elegida) : null;
      if (!e || !e.t) { barra.className = "mv-accion"; sigBarra = ""; return; }
      var t = e.t, esm = esMio(t);
      var txt = (esm ? "📍 Tu tren · " : "") + "Formación #" + (t.numero != null ? t.numero : "?") + " → " + (t.destino || "?") + " · " + demTxt(t) + (t.proximaEstacion && !t.cancelado ? " · próxima: " + bonito(t.proximaEstacion) : "");
      var sig = elegida + "|" + txt + "|" + esm;
      barra.className = "mv-accion on";
      if (sig === sigBarra) return; // no se reconstruye si no cambió: no se pierde un toque en curso
      sigBarra = sig;
      barra.textContent = "";
      var sp = document.createElement("span"); sp.textContent = txt;
      var b = document.createElement("button"); b.type = "button";
      if (esm) { b.className = "sec"; b.textContent = "Dejar de seguir"; b.addEventListener("click", function () { quitar(); }); }
      else if (t.numero != null) { b.textContent = "📍 Marcar como mi tren"; b.addEventListener("click", function () { var x = T.get(elegida); if (x && x.t) marcar(x.t, x.via); }); }
      barra.appendChild(sp);
      if (esm || t.numero != null) barra.appendChild(b);
    }

    function pintar(d) {
      datos = d;
      var est = d && d.estaciones && d.estaciones.length > 1 ? d.estaciones : null;
      if (!est) return { ida: 0, vuelta: 0 };
      if (!dibujadas || est.length !== nEst) dibujar(est);
      var tData = d.consultadoEn ? Date.parse(d.consultadoEn) : Date.now();
      mioObj = buscarMio(d); mioT = mioObj ? mioObj.tren : null;
      var vistos = {}, cuenta = { ida: 0, vuelta: 0 };
      (d.trenes || []).forEach(function (t, i) {
        var via = viaDe(t); cuenta[via]++;
        var key = via + "|" + (t.numero != null ? t.numero : "i" + i);
        vistos[key] = 1;
        var e = T.get(key);
        if (!e) { e = { key: key, via: via, el: document.createElement("div"), disp: null, pos: null, v: 0, t0: 0, tData: 0, faltas: 0, t: null }; T.set(key, e); }
        var div = e.el; e.t = t;
        div.textContent = "";
        div.className = "mv-tren " + via + " " + claseDemora(t) + (t.local ? " local" : "") + (t.origenInusual ? " origen-inusual" : "") + (t.fuente === "estimada" ? " est" : "") + (key === elegida ? " sel" : "") + (t === mioT ? " mio" : "");
        div.tabIndex = 0;
        div.setAttribute("data-k", key);
        fijarObjetivo(e, t, via, tData);
        div.appendChild(document.createTextNode(t.numero != null ? t.numero : "?"));
        div.setAttribute("role", "button");
        div.setAttribute("aria-label", "Formación " + (t.numero != null ? t.numero : "") + " hacia " + (t.destino || ""));
        var tip = document.createElement("span"); tip.className = "mv-tip";
        tip.textContent = "#" + (t.numero != null ? t.numero : "?") + (t.local ? " · LOCAL" + (t.origenLocal ? " " + t.origenLocal : "") : "") + " → " + t.destino + " · " + demTxt(t) + (t.origenInusual ? " · ⚠ origen inusual" : "") + (t.fuente === "gps" ? " · 📡 GPS" : t.fuente === "estimada" ? " · ≈ estimada" : "");
        div.appendChild(tip);
        if (t === mioT) {
          var tag = document.createElement("span"); tag.className = "mv-mio-tag";
          tag.textContent = "📍 Tu tren" + (hooks.etiqueta ? hooks.etiqueta(t) || "" : "");
          div.appendChild(tag);
        }
        if (!div.parentNode) stage.appendChild(div);
      });
      T.forEach(function (e, k) { if (!vistos[k] && ++e.faltas >= 2) { e.el.remove(); T.delete(k); } });
      stage.classList.toggle("con-mio", !!mioT);
      vacio.ida.style.display = cuenta.ida ? "none" : "block";
      vacio.vuelta.style.display = cuenta.vuelta ? "none" : "block";
      pintarResumen(); pintarBarra();
      if (hooks.despues) hooks.despues(d, mioObj);
      return cuenta;
    }
    function refrescar() { if (datos) pintar(datos); else { pintarBarra(); if (hooks.despues) hooks.despues(null, null); } }

    // ── Interacción ──
    function elegir(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest(".mv-tren") : null;
      var k = el ? el.getAttribute("data-k") : null;
      if (k === elegida) return;
      elegida = k; refrescar();
    }
    stage.addEventListener("click", elegir);
    stage.addEventListener("keydown", function (ev) { if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList && ev.target.classList.contains("mv-tren")) { ev.preventDefault(); elegir(ev); } });
    document.addEventListener("click", function (ev) { // tocar fuera de una formación o de la barra la deselecciona
      if (!elegida || (ev.target.closest && (ev.target.closest(".mv-tren") || ev.target.closest(".mv-accion")))) return;
      elegida = null; refrescar();
    });
    ["pointerdown", "wheel", "touchstart"].forEach(function (ev) { // si el usuario mueve la pantalla a mano, se deja de seguir
      window.addEventListener(ev, function () { if (sigue) sigue = false; }, { passive: true });
    });
    pill.addEventListener("click", function () { sigue = true; });
    barraMio.addEventListener("click", function (ev) { if (ev.target.closest && ev.target.closest("button")) quitar(); });

    function seguir(v) { if (v === undefined) return sigue; sigue = !!v; return sigue; }
    function centrarMio(suave) {
      var el = stage.querySelector(".mv-tren.mio");
      if (!el || !enPantalla()) return;
      var r = el.getBoundingClientRect();
      window.scrollBy({ top: r.top + r.height / 2 - window.innerHeight / 2, behavior: suave ? "smooth" : "auto" });
    }

    // ── Consulta propia (solo con api): 10 s si hay "mi tren", 15 s si no; con espera creciente ante fallas ──
    var fmtH = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false });
    function programar() {
      clearTimeout(timer);
      timer = setTimeout(actualizar, Math.min((mioT ? 10000 : 15000) * Math.pow(2, Math.min(fallas, 3)), 60000));
    }
    function estado(txt) { if (o.estadoEl) o.estadoEl.textContent = txt; }
    function actualizar() {
      if (enCurso || document.hidden) return Promise.resolve();
      enCurso = true;
      var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 12000);
      return fetch(o.api, { cache: "no-store", signal: ctl.signal })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (j) {
          var c = pintar(j);
          base = "🕐 " + fmtH.format(new Date()) + " · " + c.ida + " hacia Moreno · " + c.vuelta + " hacia Once";
          estado(base); ultimoOk = Date.now(); fallas = 0;
        })
        .catch(function () {
          fallas++;
          var seg = ultimoOk ? Math.round((Date.now() - ultimoOk) / 1000) : null;
          estado(seg ? "🕐 sin conexión hace " + seg + "s" : "🕐 no se pudo conectar");
        })
        .then(function () { clearTimeout(to); enCurso = false; programar(); });
    }
    function iniciar() {
      if (arrancado) return; arrancado = true;
      requestAnimationFrame(cuadro);
      if (!o.api) return;
      document.addEventListener("visibilitychange", function () { // al volver a la pestaña: dato fresco ya
        if (!document.hidden) { ultimoFrame = performance.now(); clearTimeout(timer); actualizar(); }
      });
      setInterval(function () { // edad del dato, solo si se está demorando
        if (fallas || !ultimoOk || !base) return;
        var seg = Math.round((Date.now() - ultimoOk) / 1000);
        estado(seg > 40 ? base + " · ⚠ datos de hace " + seg + " s" : base);
      }, 5000);
      actualizar();
    }

    return { iniciar: iniciar, pintar: pintar, refrescar: refrescar, datos: function () { return datos; }, seguir: seguir, centrarMio: centrarMio, mio: function () { return mioT; }, actualizar: actualizar };
  }

  global.MapaVivo = { version: VERSION, crear: crear, viaDe: viaDe, claseDemora: claseDemora, bonito: bonito };
})(window);
