// src/capturasApp.js
// Capturas de pantalla de la app de Trenes Argentinos que suben los usuarios
// al grupo: Gemini (visión) lee el contenido, se guarda en Firestore con la
// fecha/hora del EVENTO (la de la captura, no la de subida) y se coteja
// automáticamente contra los datos en vivo del proxy (barrido de Sarmiento).
// Todo en silencio: al grupo no se publica nada; el resultado le llega solo
// al admin por privado.
//
// Las capturas NO son fuente de verdad del bot (las sube cualquiera): sirven
// para medir cuánto coincide la app con lo que devuelve el proxy.

import { GoogleGenAI } from "@google/genai";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { barridoEstructurado, serviciosSarmiento, textoBarrido, datosServicio, hora } from "./appTrenes.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash-lite";
const COLECCION = "capturasApp";
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
const EDAD_MAX_COTEJO_MIN = 15; // una captura más vieja no es comparable con el estado "ahora"

let db = null;
function ensureInit() {
  if (db) return db;
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) return null;
  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    db = getFirestore();
    return db;
  } catch (err) {
    console.error("Error inicializando Firebase en capturasApp:", err.message);
    return null;
  }
}

let recientes = []; // { imagenHash, fileUniqueId, timestamp } — respaldo sin Firestore y para carreras
const sinAcentos = (t) => (t || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const limpiarJSON = (t) => t.replace(/```json|```/g, "").trim();

export async function capturaYaProcesada({ imagenHash, fileUniqueId }) {
  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  recientes = recientes.filter((c) => c.timestamp >= desde);
  if (recientes.some((c) => (imagenHash && c.imagenHash === imagenHash) || (fileUniqueId && c.fileUniqueId === fileUniqueId))) return true;
  const firestore = ensureInit();
  if (!firestore) return false;
  try {
    if (imagenHash) {
      const snap = await firestore.collection(COLECCION).where("imagenHash", "==", imagenHash).limit(1).get();
      if (!snap.empty) return true;
    }
  } catch (err) {
    console.error("Error chequeando capturas repetidas:", err.message);
  }
  return false;
}

export function recordarCaptura({ imagenHash, fileUniqueId }) {
  recientes.push({ imagenHash, fileUniqueId, timestamp: new Date().toISOString() });
}

const PROMPT = `
Esta imagen puede ser: (a) una CAPTURA DE PANTALLA de la app (o del sitio) de Trenes Argentinos / SOFSE (arribos de una estación, buscador de recorrido, estado del servicio, alertas), o (b) una FOTO de la CARTELERA FÍSICA/LED de una estación (el panel que cuelga arriba del andén, tipo el de la estación Once, con filas ANDÉN / destino / hora / estado PROGRAMADO o CONFIRMADO, y a veces un cartel o cinta con un aviso al pie).
Devolvé SOLO un JSON (sin markdown) con esta forma exacta:
{
  "esCapturaAppTrenes": true o false,
  "tipo": "arribos" | "recorrido" | "alerta" | "estado_servicio" | "cartelera_fisica" | "otro",
  "estacion": "estación que se está viendo (pantalla de arribos)" o null,
  "ramal": "ramal o línea" o null,
  "origen": "origen del buscador de recorrido" o null,
  "destino": "destino del buscador de recorrido" o null,
  "horaCaptura": "HH:MM" (24hs) o null,
  "horaOrigen": "reloj" (barra de estado del celular) | "app" (hora de actualización de la app) | "buscador" (campo de hora del buscador) | null,
  "fechaCaptura": "DD/MM" si la captura muestra la fecha, o null,
  "alertas": [
    { "seccion": "título del bloque tal como se ve (ej. \"Once-Moreno\", \"Sarmiento\")" o null,
      "texto": "texto del aviso, tal como se lee",
      "tipo": "operativa" | "informativa",
      "estado": "normal" | "demorado" | "interrumpido" | "cancelado" | "normalizado" | null,
      "causa": "causa breve (ej. colisión con persona)" o null,
      "lugar": "estación o zona mencionada" o null,
      "truncado": true si el texto está cortado o tapado }
  ],
  "servicios": [
    { "horaProgramada": "HH:MM" o null, "horaEstimada": "HH:MM" o null, "destino": "..." o null,
      "estado": "texto de estado tal como se ve (En andén, Partió, Cancelado, Demorado, Normal, Programado, Confirmado, etc.)" o null,
      "demoraMin": número o null, "cancelado": true o false, "leyenda": "texto extra del servicio" o null,
      "anden": "número o letra del andén, tal como se lee en esa fila/tarjeta" o null (si dice "-" o está vacío, poné null: todavía no se lo asignaron) }
  ],
  "textoDetectado": "todo el texto relevante que se lee, resumido"
}
Reglas:
- esCapturaAppTrenes=false si es una foto común, meme, publicidad, comunicado gráfico, captura de otra app o cualquier cosa que no sea la app/sitio de Trenes Argentinos. No inventes datos: si algo no se ve, null.
- Alertas: "operativa" = afecta la circulación (demoras, cancelaciones, interrupciones, colisiones, obras, paros, servicio normalizado tras un evento). "informativa" = beneficios, tarifas, campañas, recomendaciones (ej. CUD gratuito con SUBE). Listá cada bloque por separado.
- estado "normalizado" = el aviso dice que el servicio se normalizó/restableció (evento ya cerrado). "demorado" = circula con demoras. No confundas uno con otro.
- Ignorá marcas hechas a mano sobre la imagen (círculos, flechas, subrayados, tachones). Si un texto queda cortado o tapado, transcribí solo lo legible, marcá truncado=true y no lo completes.
- horaCaptura: usá el reloj de la barra de estado si se ve (horaOrigen="reloj"). Si no hay barra de estado, usá la hora de actualización de la app ("app") o, en último caso, la hora del campo del buscador ("buscador"): ese campo lo puede cambiar el usuario, por eso hay que indicar de dónde salió.
- Si la tarjeta de un tren aparece cortada, cargá en servicios solo lo que se lee completo.
- CARTELERA FÍSICA (tipo="cartelera_fisica"): "estacion" es la estación de la que es el panel (dice arriba a la izquierda, ej. "ONCE"). Cada fila/tarjeta del panel es un item de "servicios": el destino grande (ej. "MORENO") va en "destino", la hora en "horaProgramada", "PROGRAMADO"/"CONFIRMADO"/etc. en "estado", y el número del andén de esa fila en "anden" (si la columna ANDÉN dice "-", andén queda null). Un texto que se desplaza al pie del panel (cinta/ticker) va como alerta, tipo="informativa" salvo que hable de demoras/servicio reducido/cancelaciones (ahí es "operativa"); si está cortado por el borde de la foto, marcá truncado=true.
`.trim();

const ESTADOS_ALERTA = ["normal", "demorado", "interrumpido", "cancelado", "normalizado"];
const HORA_ORIGENES = ["reloj", "app", "buscador"];
const RE_OPERATIVA = /demora|cancel|interrump|colisi|normaliz|restablec|suspend|obra|paro|sin servicio|servicio limitado|falla|incidente/i;
const slug = (t) => sinAcentos(t).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Ordena la lectura de Gemini: separa alertas operativas de informativas
// (el cartel del CUD, por ejemplo, no es una alerta del servicio) y arma una
// clave de incidente (ramal + lugar + causa) para poder agrupar reportes del
// mismo evento y cerrar uno abierto cuando llega un "normalizado".
export function normalizarLectura(datos) {
  let alertas = Array.isArray(datos.alertas) ? datos.alertas : [];
  if (!alertas.length && datos.alertaTexto) alertas = [{ texto: datos.alertaTexto }]; // formato viejo
  alertas = alertas
    .filter((a) => a && typeof a.texto === "string" && a.texto.trim())
    .map((a) => {
      const texto = a.texto.trim();
      const tipo = a.tipo === "operativa" || a.tipo === "informativa" ? a.tipo : RE_OPERATIVA.test(texto) ? "operativa" : "informativa";
      const estado = tipo === "operativa" && ESTADOS_ALERTA.includes(a.estado) ? a.estado : null;
      const out = { seccion: a.seccion || null, texto, tipo, estado, causa: a.causa || null, lugar: a.lugar || null, truncado: !!a.truncado };
      if (tipo === "operativa") {
        const clave = slug([datos.ramal || a.seccion, a.lugar, a.causa].filter(Boolean).join(" "));
        out.incidenteClave = clave || null;
      }
      return out;
    });
  const operativas = alertas.filter((a) => a.tipo === "operativa");
  return {
    ...datos,
    alertas,
    alertaTexto: operativas.length ? operativas.map((a) => (a.seccion ? `${a.seccion}: ` : "") + a.texto).join(" | ") : null,
    horaOrigen: HORA_ORIGENES.includes(datos.horaOrigen) ? datos.horaOrigen : null,
  };
}

export async function analizarCapturaApp(base64Data, mimeType = "image/jpeg") {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64Data } }] }],
  });
  const texto = limpiarJSON(response.text.trim());
  try {
    return normalizarLectura(JSON.parse(texto));
  } catch {
    throw new Error("No pude interpretar la lectura de la captura como JSON: " + texto.slice(0, 200));
  }
}

// Fecha/hora del evento: la de la captura (reloj del celular) y no la de
// subida. Sin fecha en la captura se asume el día de la subida, o el día
// anterior si esa hora queda en el futuro.
export function calcularEventoEn(horaCaptura, fechaCaptura, subidoEn, horaOrigen = null) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(horaCaptura || "");
  if (!m) return { eventoEn: subidoEn, origen: "subida" };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return { eventoEn: subidoEn, origen: "subida" };
  const ar = new Date(subidoEn.getTime() - AR_OFFSET_MS); // campos UTC = reloj de Buenos Aires
  let anio = ar.getUTCFullYear();
  let mes = ar.getUTCMonth();
  let dia = ar.getUTCDate();
  const f = /^(\d{1,2})\/(\d{1,2})$/.exec(fechaCaptura || "");
  if (f) {
    dia = Number(f[1]);
    mes = Number(f[2]) - 1;
  }
  let ms = Date.UTC(anio, mes, dia, hh, mm) + AR_OFFSET_MS;
  if (!f && ms > subidoEn.getTime() + 10 * 60 * 1000) ms -= 24 * 60 * 60 * 1000;
  if (f && ms > subidoEn.getTime() + 24 * 60 * 60 * 1000) ms = Date.UTC(anio - 1, mes, dia, hh, mm) + AR_OFFSET_MS;
  const base = f ? "captura (fecha y hora)" : "captura (hora)";
  return { eventoEn: new Date(ms), origen: horaOrigen === "buscador" ? `${base}, del buscador: puede no ser la hora real` : base };
}

export async function guardarCaptura(datos, meta) {
  const registro = {
    ...datos,
    servicios: Array.isArray(datos.servicios) ? datos.servicios : [],
    eventoEn: meta.eventoEn.toISOString(),
    eventoOrigen: meta.eventoOrigen,
    subidoEn: meta.subidoEn.toISOString(),
    subidoPor: meta.quien,
    userId: meta.userId ?? null,
    chatId: meta.chatId ?? null,
    threadId: meta.threadId ?? null,
    imagenHash: meta.imagenHash ?? null,
    fileUniqueId: meta.fileUniqueId ?? null,
    fileId: meta.fileId ?? null,
  };
  const firestore = ensureInit();
  if (!firestore) {
    console.log("[capturasApp fallback]", JSON.stringify(registro).slice(0, 500));
    return { id: null };
  }
  try {
    const ref = await firestore.collection(COLECCION).add({ ...registro, creadoEn: FieldValue.serverTimestamp() });
    return { id: ref.id };
  } catch (err) {
    console.error("Error guardando captura en Firestore:", err.message);
    return { id: null };
  }
}

export async function guardarCotejo(id, cotejo) {
  const firestore = ensureInit();
  if (!firestore || !id) return;
  try {
    await firestore.collection(COLECCION).doc(id).update({ cotejo, cotejadoEn: new Date().toISOString() });
  } catch (err) {
    console.error("Error guardando cotejo de captura:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Revisión por Telegram: "tomar el dato" (actualiza el semáforo) o "ignorar"
// ---------------------------------------------------------------------------
// Estado de la alerta -> estado del semáforo del sitio (normal | modificado | paro)
const A_SEMAFORO = { interrumpido: "paro", cancelado: "modificado", demorado: "modificado", normal: "normal", normalizado: "normal" };
const SEVERIDAD = { interrumpido: 3, cancelado: 2, demorado: 2, normal: 1, normalizado: 1 };

// Qué le propondría el bot al admin a partir de las alertas operativas de la
// captura. Si hay varias, gana la más grave. Solo se propone cuando hay un
// estado claro; las capturas sin alerta (o con un estado que no se pudo leer)
// no generan propuesta.
export function proponerEstado(datos) {
  const d = normalizarLectura(datos || {});
  const ops = d.alertas.filter((a) => a.tipo === "operativa" && SEVERIDAD[a.estado]);
  if (!ops.length) return null;
  const max = Math.max(...ops.map((a) => SEVERIDAD[a.estado]));
  const elegidas = ops.filter((a) => SEVERIDAD[a.estado] === max);
  const estado = A_SEMAFORO[elegidas[0].estado];
  const mensaje = estado === "normal" ? undefined : elegidas.map((a) => a.texto).join(" ").slice(0, 300);
  return { estado, mensaje, truncado: elegidas.some((a) => a.truncado), lugar: elegidas[0].lugar || null };
}

export async function obtenerCaptura(id) {
  const firestore = ensureInit();
  if (!firestore || !id) return null;
  const snap = await firestore.collection(COLECCION).doc(id).get();
  return snap.exists ? snap.data() : null;
}

export async function marcarRevisionCaptura(id, revision) {
  const firestore = ensureInit();
  if (!firestore || !id) throw new Error("Firestore no está configurado.");
  await firestore.collection(COLECCION).doc(id).update({ revision });
}

// Resuelve el botón que tocó el admin. `aplicarEstado` es la función que
// escribe el semáforo (actualizarEstadoServicio). Una captura ya revisada no
// se vuelve a aplicar (doble toque o botón viejo).
export async function revisarCaptura({ id, accion, quien }, { aplicarEstado, obtener = obtenerCaptura, marcar = marcarRevisionCaptura }) {
  const cap = await obtener(id);
  if (!cap) return { resultado: "no_encontrada" };
  if (cap.revision) return { resultado: "ya_revisada", revision: cap.revision };
  const en = new Date().toISOString();
  if (accion === "ignorar") {
    await marcar(id, { accion: "ignorado", por: quien, en });
    return { resultado: "ignorada" };
  }
  const propuesta = proponerEstado(cap);
  if (!propuesta) return { resultado: "sin_propuesta" };
  await aplicarEstado({ estado: propuesta.estado, mensaje: propuesta.mensaje, editor: "Telegram (HG) · captura app" });
  await marcar(id, { accion: "tomado", estado: propuesta.estado, mensaje: propuesta.mensaje ?? null, por: quien, en });
  return { resultado: "tomada", propuesta };
}

// ---------------------------------------------------------------------------
// Cotejo contra el proxy
// ---------------------------------------------------------------------------
const minutosDelDia = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const difMin = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
};

function buscarEnProxy(sv, pool, estacion) {
  const est = sinAcentos(estacion);
  const dest = sinAcentos(sv.destino);
  const prog = minutosDelDia(sv.horaProgramada) ?? minutosDelDia(sv.horaEstimada);
  if (prog == null) return null;
  return (
    pool.find((item) => {
      const d = datosServicio(item);
      if (est && !sinAcentos(item.est.nombre).includes(est) && !est.includes(sinAcentos(item.est.nombre))) return false;
      if (dest && d.destino && !sinAcentos(d.destino).includes(dest) && !dest.includes(sinAcentos(d.destino))) return false;
      const pProxy = minutosDelDia(hora(d.prog));
      return pProxy != null && difMin(pProxy, prog) <= 2;
    }) || null
  );
}

export async function cotejarCaptura(datos, eventoEn, ahora = new Date()) {
  const edadMin = Math.round((ahora - eventoEn) / 60000);
  const barrido = await barridoEstructurado();
  const lineas = [];

  // Pool de comparación: si la estación de la captura no está entre las del
  // barrido, se consulta esa estación puntualmente al proxy.
  const est = sinAcentos(datos.estacion);
  let pool = barrido.todos;
  if (est && !barrido.todos.some((i) => sinAcentos(i.est.nombre).includes(est) || est.includes(sinAcentos(i.est.nombre)))) {
    try {
      const extra = await serviciosSarmiento(datos.estacion);
      pool = barrido.todos.concat(extra.servicios);
      if (!extra.servicios.length) lineas.push(`ℹ️ El proxy no devolvió servicios de Sarmiento para "${datos.estacion}".`);
    } catch (err) {
      lineas.push(`ℹ️ No pude consultar la estación "${datos.estacion}" en el proxy: ${err.message}`);
    }
  }
  let coinciden = 0;
  let discrepancias = 0;
  let noEncontrados = 0;
  let andenesCoinciden = 0;
  let andenesDistintos = 0;
  let andenesSinDatoProxy = 0;

  for (const sv of datos.servicios || []) {
    const etiqueta = `${sv.horaProgramada || sv.horaEstimada || "--:--"} → ${sv.destino || "?"}`;
    const item = buscarEnProxy(sv, pool, datos.estacion);
    if (!item) {
      noEncontrados++;
      lineas.push(`❓ ${etiqueta}: no lo encontré en el proxy`);
      continue;
    }
    const d = datosServicio(item);
    const problemas = [];
    const proxyCancel = !!d.s.cancelacion;
    if (!!sv.cancelado !== proxyCancel) problemas.push(sv.cancelado ? "la captura dice CANCELADO y el proxy no informa cancelación" : "el proxy informa cancelación y la captura no");
    if (sv.demoraMin != null && d.demora != null && Math.abs(sv.demoraMin - d.demora) > 3) problemas.push(`demora: captura ${sv.demoraMin} min vs proxy ${d.demora} min`);
    if (sv.leyenda && !d.s.leyenda) problemas.push(`la captura tiene leyenda ("${String(sv.leyenda).slice(0, 60)}") y el proxy no`);
    if (sv.anden) {
      if (d.anden && String(d.anden).trim() === String(sv.anden).trim()) andenesCoinciden++;
      else if (d.anden) { andenesDistintos++; problemas.push(`andén: cartel dice ${sv.anden}, proxy dice ${d.anden}`); }
      else andenesSinDatoProxy++; // el cartel SÍ tiene andén y el proxy no trajo ninguno para este tren — dato clave para calibrar el campo
    }
    if (problemas.length) {
      discrepancias++;
      lineas.push(`⚠️ ${etiqueta}: ${problemas.join("; ")}`);
    } else {
      coinciden++;
      lineas.push(`✅ ${etiqueta}: coincide${d.demora != null ? ` (proxy ${d.demora >= 0 ? "+" : ""}${d.demora} min)` : ""}${sv.anden ? ` · andén ${sv.anden} = proxy` : ""}`);
    }
  }
  if (andenesCoinciden || andenesDistintos || andenesSinDatoProxy) {
    lineas.push(
      `🚉 Andén: ${andenesCoinciden} coincide(n) con el proxy, ${andenesDistintos} distinto(s), ${andenesSinDatoProxy} sin dato de andén en el proxy` +
        (andenesCoinciden + andenesDistintos > 0 ? " — el campo de andén que usa el bot parece funcionar." : " — el proxy no está devolviendo andén para lo que muestra el cartel; revisar el nombre del campo con /apptrenes get.")
    );
  }

  // ¿La alerta/leyenda que se ve en la app llega por el proxy?
  const hayAlertaEnCaptura = !!(datos.alertaTexto || (datos.servicios || []).some((s) => s.leyenda || s.cancelado));
  const proxyTieneTexto = pool.some((item) => item.r?.servicio?.cancelacion || item.r?.servicio?.leyenda);
  let alertaEnProxy = null;
  if (hayAlertaEnCaptura) {
    alertaEnProxy = proxyTieneTexto;
    lineas.push(
      proxyTieneTexto
        ? "📢 La captura muestra una alerta/cancelación y el proxy también trae cancelaciones o leyendas (ver barrido)."
        : "📢 La captura muestra una alerta/cancelación pero el proxy NO trae ninguna cancelación ni leyenda en este momento: esa info no está llegando por este endpoint."
    );
  }

  return {
    edadMin,
    vieja: edadMin > EDAD_MAX_COTEJO_MIN,
    coinciden,
    discrepancias,
    noEncontrados,
    alertaEnCaptura: hayAlertaEnCaptura,
    alertaEnProxy,
    serviciosProxy: barrido.todos.length,
    anormalesProxy: barrido.anormales.length,
    erroresProxy: barrido.errores.length,
    lineas,
    textoBarrido: textoBarrido(barrido),
  };
}

export function armarReporte({ datos, quien, chatTitle, threadId, eventoEn, eventoOrigen, subidoEn, cotejo, guardadoId }) {
  const fmt = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const serv = (datos.servicios || []).slice(0, 10).map((s) => `  • ${s.horaProgramada || "--:--"}${s.horaEstimada ? ` (est ${s.horaEstimada})` : ""} → ${s.destino || "?"} | ${s.estado || "s/d"}${s.anden ? ` | andén ${s.anden}` : ""}${s.demoraMin != null ? ` | ${s.demoraMin} min` : ""}${s.cancelado ? " | CANCELADO" : ""}${s.leyenda ? ` | "${String(s.leyenda).slice(0, 60)}"` : ""}`);
  const esCartel = datos.tipo === "cartelera_fisica";
  let t = `${esCartel ? "🖥️ Foto de la cartelera física" : "📱 Captura de la app"} de Trenes Argentinos\n👤 ${quien} en «${chatTitle || "grupo"}»${threadId ? ` (tema ${threadId})` : ""}\n`;
  t += `🕒 Evento: ${fmt(eventoEn)} (${eventoOrigen}) · subida ${fmt(subidoEn)}\n`;
  t += `📍 ${datos.estacion || "estación s/d"}${datos.ramal ? ` · ${datos.ramal}` : ""} · tipo: ${datos.tipo || "s/d"}\n`;
  if (datos.origen || datos.destino) t += `🧭 Recorrido buscado: ${datos.origen || "?"} → ${datos.destino || "?"}\n`;
  const ops = (datos.alertas || []).filter((a) => a.tipo === "operativa");
  const infos = (datos.alertas || []).length - ops.length;
  for (const a of ops) t += `📢 ${a.seccion ? a.seccion + " · " : ""}${a.estado || "s/estado"}${a.lugar ? ` · ${a.lugar}` : ""}${a.causa ? ` · ${a.causa}` : ""}${a.truncado ? " (texto cortado)" : ""}\n   "${String(a.texto).slice(0, 300)}"\n`;
  if (!ops.length && datos.alertaTexto) t += `📢 Alerta en la app: "${String(datos.alertaTexto).slice(0, 400)}"\n`;
  if (infos > 0) t += `ℹ️ ${infos} aviso(s) informativo(s) ignorado(s) (no afectan el servicio).\n`;
  t += `Servicios leídos: ${(datos.servicios || []).length}${serv.length ? "\n" + serv.join("\n") : ""}\n`;
  t += guardadoId ? `💾 Guardada en Firestore (capturasApp/${guardadoId}).\n` : "💾 No pude guardarla en Firestore (revisar logs).\n";
  if (cotejo) {
    t += `\n🔎 Cotejo contra el proxy (ahora): ✅ ${cotejo.coinciden} · ⚠️ ${cotejo.discrepancias} · ❓ ${cotejo.noEncontrados}\n`;
    if (cotejo.vieja) t += `⏳ La captura tiene ${cotejo.edadMin} min: el proxy muestra el estado de AHORA, así que las diferencias pueden ser por el paso del tiempo.\n`;
    t += cotejo.lineas.length ? cotejo.lineas.join("\n") + "\n" : "(la captura no trae servicios para comparar uno a uno)\n";
    t += `\n${cotejo.textoBarrido}`;
  }
  return t;
}
