// src/index.js
// Bot de Telegram para el grupo de Tren Sarmiento En Línea.
// Corre como servidor Express + webhook de Telegraf, pensado para el free
// tier de Render (el free tier "duerme" tras inactividad, pero al usar
// webhook -en vez de polling- Telegram simplemente espera la respuesta
// cuando Render lo despierta; no hace falta mantenerlo despierto).
//
// ⚠️ ESTE REPO SE EDITA DESDE MÚLTIPLES SESIONES DE CLAUDE EN PARALELO.
// Si sos una sesión de Claude leyendo esto: corré `git fetch origin && git
// log HEAD..origin/main --oneline` (o directamente `git pull --ff-only`)
// ANTES de editar este archivo o cualquier otro de bot/src — incluso si
// clonaste el repo hace poco en esta misma conversación. Ya pasó más de una
// vez que una sesión con una copia vieja pisó sin querer /informe, /estado,
// logsGrupo y la sección de noticias porque no volvió a sincronizar antes
// de escribir. Si hay commits nuevos que no reconocés, mirá el mensaje del
// commit y el diff antes de sobrescribir nada — probablemente sea trabajo
// de otra sesión que hay que preservar, no descartar.

import "dotenv/config";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import NodeCache from "node-cache";

import { TREN_SARMIENTO_INFO, RESPUESTA_SIN_DATO, RESPUESTA_ERROR_TECNICO } from "./staticData.js";
import { getEstadoServicio, actualizarEstadoServicio, agregarAlertaComplementaria, listarAlertasComplementarias, quitarAlertaComplementaria, limpiarAlertasComplementarias, alCambiarEstado, alAgregarAlerta } from "./firestoreStatus.js";
import { enviarPush, ultimaPushId, pushAutoActivo, setPushAuto, cargarPushAuto, iniciarPushAuto, pushPorCambioEstado, pushPorAlerta } from "./pushAuto.js";
import { crearPropuesta, revisarPropuesta } from "./propuestasEstado.js";
import { getAlertasTrenes } from "./apiTransporte.js";
import { responderPregunta, SIN_RESPUESTA_SENTINEL, esErrorTransitorio, generarMensajeRetomar, formatearTablaSalidas } from "./gemini.js";
import { detectarEstaciones, proximosTrenesEnEstacion, ultimosTrenes, horaArgentinaTexto, proximosLocales, proximosLocalesTodasEstaciones, proximoDiferencial, DIFERENCIAL, horariosLocalesEstacion, horariosLocalesEstacionTodosLosDias, LOCALES, getDayType, infoTransporteEstacion, buscarEstacion } from "./schedule.js";
import { registrarMensajeGrupo, getSenalComunidad } from "./complaintTracker.js";
import { incrementarContadorMensajes, detectarTema, yaRespondidoRecientemente, registrarRespuestaAlAire, olvidarTema } from "./respuestaDedupe.js";
import { evaluarSpam } from "./spamDetector.js";
import { reporteEstacion, barridoSarmiento, proximasSalidas, barridoEstructurado, trenesConOrigenInusual, textoCancelacion, datosServicio, hora, consultarProxy, filasParaTabla, columnasCabecera, posicionesEnVivo, ESTACIONES_BARRIDO, arribosVivosEstacion } from "./appTrenes.js";
import { generarImagenTablero, generarImagenProximoTren } from "./tableroImagen.js";
import { tableroVivoHTML } from "./tableroVivo.js";
import { registrarSnapshot, snapshotHaceMinutos, rangoRegistrado } from "./tableroHistorial.js";
import { mapaVivoHTML } from "./mapaVivo.js";
import { iniciarVigiaSalidas, textoFormaciones, estadoLocalesParaBot } from "./vigiaSalidas.js";
import { textoInformeFormaciones } from "./informeFormaciones.js";
import { registrarValidacion, excedioLimiteValidaciones, textoValidaciones } from "./validacionesGps.js";
import { iniciarViaje, estadoViaje, ubicacionUsuario, iniciarViajes, hayViajeActivo } from "./viaje.js";
import { chequearCancelacionesProxy, chequearDemorasProxy, chequearOrigenesInusuales, chequearLocalesFueraCronograma, chequearTramoLimitadoProxy, contextoProxyParaBot } from "./proxyMonitor.js";
import { esConsultaSalidasOnce, LINK_TABLERO } from "./tableroOnce.js";
import { getTramoLimitado, setTramoLimitado, limpiarTramoLimitado, extraerEstaciones, idxEstacion, tramoIncluye, resumenTramo, textoTramoParaContexto } from "./servicioLimitado.js";
import { reporteLocales } from "./locales.js";
import { evaluarEstadoAutomatico, cargarEstadoAuto, setEstadoAuto, estadoAutoActivo } from "./estadoAuto.js";
import { escaneoCompletoActivo, cargarEscaneoCompleto, setEscaneoCompleto } from "./appTrenesAuto.js";
import { describirVideo } from "./videoIntel.js";
import { capturaYaProcesada, recordarCaptura, analizarCapturaApp, calcularEventoEn, guardarCaptura, guardarCotejo, cotejarCaptura, armarReporte, proponerEstado, revisarCaptura } from "./capturasApp.js";
import { esOcupacionEnVivo } from "./ocupacion.js";
import { esConsultaDeLuz, mencionaEnergia, RESPUESTA_SIN_DATO_LUZ } from "./luz.js";
import { instalarSilencio, cargarSilencio, setSilencio, estaSilenciado } from "./silencio.js";
import { esFuenteVerdad, procesarMensajeFuente, transcribirAudio, avisosVigentes, textoAvisosParaContexto, cerrarTodosLosAvisos } from "./avisosFuente.js";
import { registrarChatPrivado } from "./privateChatLogger.js";
import { registrarChatGrupo, listarTemasRecientes } from "./groupChatLogger.js";
import { guardarReporte, listarReportesPendientes, marcarReporteRevisado } from "./reportLogger.js";
import { publicarNoticia } from "./noticiaPublisher.js";
import { consultarParoEnVivo } from "./paroSearch.js";
import { consultarColectivoEnVivo } from "./colectivoSearch.js";
import { chequearYNotificar } from "./monitor.js";
import { chequearYEnviarInformeDiario, generarInformeTexto, listarFallidosRecientes, reintentarFallidosGuardados, listarUsuariosPrivados, getHistorialUsuario, getUltimaPreguntaUsuario } from "./dailyReport.js";
import { encolarReintento, listaPendientes, marcarIntento, quitarDeCola } from "./retryQueue.js";
import { esInsulto } from "./insultDetector.js";
import { excedioLimite } from "./rateLimiter.js";
import { analizarComunicadoImagen, guardarComunicado, comunicadosRecientes, listarComunicados, hashImagen, esImagenYaProcesada, buscarComunicadoDuplicado, registrarImagenDescartada } from "./imageIntel.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN en las variables de entorno.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
instalarSilencio(bot); // /silencio: desvía al admin lo que iría al grupo
const app = express();
app.use(express.json());

// Evita responder la misma pregunta 10 veces en 30 segundos si varios la
// repiten en el grupo (protege la cuota gratuita de Gemini).
const cache = new NodeCache({ stdTTL: 120 });

let botUsername = null;
bot.telegram.getMe().then((me) => {
  botUsername = me.username;
  console.log(`Bot iniciado como @${botUsername}`);
});

// Restricción al grupo autorizado: si alguien agrega el bot a otro grupo,
// se va solo apenas Telegram le avisa del cambio de membresía (no hace
// falta esperar a que alguien le escriba).
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.myChatMember.chat;
  if (chat.type === "private") return;
  if (!process.env.ALLOWED_GROUP_ID) return; // sin restricción configurada, no hace nada

  const nuevoEstado = ctx.myChatMember.new_chat_member?.status;
  const fueAgregado = nuevoEstado === "member" || nuevoEstado === "administrator";
  if (fueAgregado && String(chat.id) !== String(process.env.ALLOWED_GROUP_ID)) {
    console.warn(`Bot agregado a un grupo NO autorizado (${chat.id} — "${chat.title}"). Saliendo...`);
    try {
      await ctx.leaveChat();
    } catch (err) {
      console.error("Error al intentar salir del grupo no autorizado:", err.message);
    }
  }
});

// Defensa adicional: si por algún motivo el bot sigue en un grupo no
// autorizado (ej. quedó agregado antes de configurar esta variable), no
// procesa ningún mensaje de ahí.
function esChatAutorizado(ctx) {
  if (ctx.chat?.type === "private") return true;
  if (!process.env.ALLOWED_GROUP_ID) return true;
  return String(ctx.chat.id) === String(process.env.ALLOWED_GROUP_ID);
}

// En grupos con Temas (forum), Telegram manda reply_to_message en TODOS los
// mensajes de un tema, apuntando al mensaje de creación del tema (cuyo
// message_id == message_thread_id). Eso NO es una respuesta real a nadie: si
// lo tratamos como reply, el bot cree que le están hablando a otra persona y
// se queda callado en todos los temas. Devuelve el reply real, o null.
function replyReal(ctx) {
  const r = ctx.message?.reply_to_message;
  if (!r) return null;
  if (r.forum_topic_created || r.forum_topic_edited || r.forum_topic_closed || r.forum_topic_reopened) return null;
  const hilo = ctx.message?.message_thread_id;
  if (hilo && r.message_id === hilo) return null;
  return r;
}

function mencionaAlBot(ctx) {
  const text = ctx.message?.text ?? "";
  const esRespuestaAlBot =
    replyReal(ctx)?.from?.username === botUsername;
  const loMencionan = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
  const esChatPrivado = ctx.chat?.type === "private";
  return esChatPrivado || esRespuestaAlBot || loMencionan;
}

// Palabras que indican que el mensaje probablemente es sobre el tren/AMBA.
// Ajustá esta lista a gusto: cuanto más específica, menos falsos positivos.
const PALABRAS_TEMA = [
  "tren", "sarmiento", "horario", "horarios", "frecuencia", "frecuencias",
  "tarifa", "tarifas", "boleto", "boletos", "sube", "estación", "estacion",
  "andén", "anden", "demora", "demorado", "parado", "combinación",
  "combinacion", "subte", "colectivo", "amba", "moreno", "once", "liniers",
  "castelar", "morón", "moron", "merlo", "ramos mejía", "haedo", "ituzaingó",
  "perdí", "perdi", "perdido", "perdida", "encontré", "encontre", "encontrado",
  "objeto", "mochila", "celular", "olvidé", "olvide", "quedó", "quede",
  "local", "locales", "diferencial", "preferencial", "paro", "huelga",
  "gremial", "gremiales", "cese", "medida de fuerza", "primer tren",
  "último tren", "ultimo tren", "flores", "floresta", "villa luro",
  "ciudadela", "san antonio", "padua", "paso del rey", "transporte",
  "servicio", "funciona", "funcionando", "circula",
  "circulando", "esperando", "espera", "cancelado", "cancelada",
  "cancelaron", "suspendido", "suspendida",
];

// Palabras/signos que indican que es una pregunta. Las "fuertes" alcanzan solas;
// las "débiles" (cómo, hay, cuando…) se buscan como PALABRA completa, porque
// como texto suelto matchean en frases que no son preguntas ("viajé bien, como
// siempre") y el bot terminaba contestando comentarios.
const PISTAS_PREGUNTA_FUERTES = ["?", "¿", "alguien sabe", "a qué hora", "a que hora", "qué hora", "que hora"];
const RE_PISTAS_PREGUNTA_DEBILES = /(^|[^a-záéíóúñ])(cu[aá]ndo|cu[aá]nto|d[oó]nde|c[oó]mo|hay|sabe)([^a-záéíóúñ]|$)/i;

// Comentario al aire de que el viaje/servicio anduvo bien ("viajé bien",
// "llegué bien", "todo normal", "sin demoras"). NO es una consulta: el bot no
// responde nada (a pedido de Coco, 29/9). Solo aplica si no hay signo de pregunta.
const RE_COMENTARIO_POSITIVO =
  /(viaj[eéó]|llegu[eé]|lleg[oó]|anduvo|funcion[oó]|pas[eé]|sali[oó]|fue|iba|va|est[aá]|todo|vengo|vine)[^?¿\n]{0,40}(\bbien\b|normal|tranquil|sin (problemas|demoras|novedades|inconvenientes)|perfecto|puntual|r[aá]pido)|\bsin (problemas|demoras|novedades|inconvenientes)\b/i;
function esComentarioPositivo(text) {
  return !/[?¿]/.test(text) && RE_COMENTARIO_POSITIVO.test(text);
}

function pareceConsultaRelevante(text) {
  const lower = text.toLowerCase();
  if (esComentarioPositivo(lower)) return false; // comentario de que viajó bien: no se responde
  const tieneTema = PALABRAS_TEMA.some((p) => lower.includes(p));
  const tienePregunta = PISTAS_PREGUNTA_FUERTES.some((p) => lower.includes(p)) || RE_PISTAS_PREGUNTA_DEBILES.test(lower);
  return tieneTema && tienePregunta;
}

function limpiarMencion(text) {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
}

// En grupos con "Temas" (forum topics) activados, si no le decimos a Telegram
// en qué tema responder, el mensaje cae en "General" y la persona que
// preguntó en otro tema nunca lo ve. Este helper arma las opciones de reply
// incluyendo el tema correcto cuando corresponde.
function opcionesRespuesta(ctx) {
  const opciones = { reply_to_message_id: ctx.message.message_id };
  if (ctx.message.message_thread_id) {
    opciones.message_thread_id = ctx.message.message_thread_id;
  }
  return opciones;
}

// Si el modelo no tuvo una respuesta concreta: cuando le hablaron directo
// (mención, reply, o chat privado) el bot lo dice con honestidad; cuando fue
// una pregunta "al aire" sin que lo mencionen, el bot prefiere quedarse
// callado antes que meter ruido en el grupo con un "no sé" sin que se lo
// pidan. Devuelve el texto a enviar, o null si no hay que responder nada.
// El bot no habla con "Che": se saca si el modelo lo usa de muletilla al
// arrancar el mensaje o una oración.
function quitarChe(texto) {
  return texto
    .replace(/(^|[.!?¡¿]\s+)che[,!]?\s+(\S)/gi, (_, ini, c) => `${ini}${c.toUpperCase()}`)
    .replace(/,?\s+che([,.!?])/gi, "$1");
}

// Respuesta en prosa que en el fondo es "no sé / no tengo el dato". Al aire
// (sin que lo mencionen) eso es ruido: el bot se queda callado igual que con
// el sentinel, aunque el modelo no haya usado SIN_RESPUESTA_CONCRETA.
const RE_NO_SE =
  /\bno\s+(s[eé]|tengo|cuento\s+con|dispongo\s+de|manejo)(?![\p{L}])[^.!?\n]{0,80}\b(dato|datos|info|informaci[oó]n|fecha|certeza|confirmaci[oó]n|novedad|novedades)\b|\bno\s+s[eé](?![\p{L}])|\bno\s+tengo\s+(forma|manera|c[aá]maras?)|\bno\s+me\s+(consta|figura|llegaron?)/iu;

function manejarSinRespuesta(respuestaCruda, fueEtiquetado) {
  const esSinRespuesta = respuestaCruda.trim() === SIN_RESPUESTA_SENTINEL;
  if (esSinRespuesta) return fueEtiquetado ? RESPUESTA_SIN_DATO : null;
  if (!fueEtiquetado && RE_NO_SE.test(respuestaCruda)) return null;
  return quitarChe(respuestaCruda);
}

// ¿Alguna fuente viva (avisos, semáforo, alertas API, comunicados) habla de
// luz/energía? Sin eso, el bot no sabe si hay luz y no debe contestarlo.
async function hayDatoDeEnergia() {
  const textos = [];
  try { for (const a of await avisosVigentes()) textos.push(a.resumen, a.textoOriginal); } catch {}
  try { const e = await getEstadoServicio(); if (e) textos.push(e.mensaje, ...e.alertas); } catch {}
  try { const al = await getAlertasTrenes(); if (al) textos.push(JSON.stringify(al)); } catch {}
  try { for (const c of await comunicadosRecientes(48)) textos.push(c.resumen); } catch {}
  return mencionaEnergia(...textos);
}

async function armarContexto(pregunta) {
  const partes = [TREN_SARMIENTO_INFO];

  // Avisos de la fuente de verdad (texto de Vivi): van primero y mandan sobre
  // el semáforo, las alertas y la señal informal. Siempre con vencimiento.
  const avisos = await avisosVigentes();
  if (avisos.length) partes.push(textoAvisosParaContexto(avisos));

  // Servicio limitado vigente (tramo donde SÍ circulan trenes): manda sobre el
  // cronograma y sobre los trenes "programados" que el proxy siga listando.
  const tramoLimitado = await getTramoLimitado().catch(() => null);
  if (tramoLimitado) partes.push(textoTramoParaContexto(tramoLimitado));

  // App de Trenes Argentinos (proxy), declarada fuente de verdad: cancelaciones
  // y leyendas que el proxy devuelve AHORA. Si el proxy está caído o tarda,
  // no debe voltear la respuesta al usuario.
  try {
    const ctxProxy = await contextoProxyParaBot();
    if (ctxProxy) partes.push(ctxProxy);
  } catch (err) {
    console.error("Error armando contexto del proxy de la app:", err.message);
  }

  const estado = await getEstadoServicio();
  if (estado) {
    partes.push(
      `\n== ESTADO EN VIVO (semáforo trensarmientoenlinea.com.ar) ==\nEstado: ${estado.etiqueta}\nMensaje: ${estado.mensaje}${estado.alertas.length ? `\nAlertas activas: ${estado.alertas.join(" | ")}` : ""}${estado.vigencia ? `\nVigente desde ${estado.vigencia.desde} hasta ${estado.vigencia.hasta}` : ""}\nÚltima actualización: ${estado.ultimaActualizacion || estado.actualizado || "desconocida"}`
    );
  }

  const alertas = await getAlertasTrenes();
  if (alertas) {
    partes.push(`\n== ALERTAS API TRANSPORTE ==\n${JSON.stringify(alertas)}`);
  }

  // Comunicados oficiales leídos de imágenes (colaboradores/admin), últimas
  // 48hs. Complementa al semáforo — puede traer datos más específicos
  // (fecha, horario puntual) que el semáforo no tiene cargados.
  const comunicados = await comunicadosRecientes(48);
  if (comunicados.length) {
    const listado = comunicados
      .map((c) => `- [${c.tipo}] ${c.fecha ? `Fecha: ${c.fecha}. ` : ""}${c.horario ? `Horario: ${c.horario}. ` : ""}${c.resumen}`)
      .join("\n");
    partes.push(
      `\n== COMUNICADOS OFICIALES RECIENTES (leídos de imágenes, últimas 48hs) ==\n${listado}\nEstos son extraídos automáticamente de fotos de comunicados — pueden tener algún error de lectura, pero son la fuente más específica si mencionan fecha/horario puntual.`
    );
  }

  // Señal informal: actividad del grupo sin menciones de problemas.
  // Solo se usa como apoyo — nunca reemplaza el estado oficial de arriba.
  const senal = getSenalComunidad();
  if (senal) {
    partes.push(
      `\n== SEÑAL INFORMAL DEL GRUPO (auxiliar, NO oficial) ==\n${senal.interpretacion}\nUsala solo como indicio adicional. Si hay un estado oficial cargado arriba (semáforo de Firestore), ese manda siempre por sobre esta señal.`
    );
  }

  // Solo para paros/medidas gremiales: caso extremo donde vale la pena una
  // búsqueda web real (cacheada unas horas para no repetirla de más).
  if (/\bparo\b|paros|huelga|medida gremial|medida de fuerza|cese de (actividades|servicio)|gremial(es)?/i.test(pregunta)) {
    const paro = await consultarParoEnVivo();
    if (paro) {
      partes.push(
        `\n== BÚSQUEDA WEB EN VIVO — PAROS/MEDIDAS GREMIALES (${paro.deCache ? "resultado en caché, buscado" : "recién buscado"} el ${paro.buscadoEn}) ==\n${paro.texto}\nEsto viene de una búsqueda web real (no es un dato fijo cargado a mano). Aclará que conviene confirmar cerca del horario de viaje en @TrenSarmiento, @InfoTSarmiento o trensarmientoenlinea.com.ar, porque estas cosas pueden cambiar de último momento.`
      );
    }
  }

  // Preguntas sobre líneas de colectivo: no tenemos esa info cargada a
  // mano, así que acá sí vale una búsqueda web real (cacheada).
  if (/\bcolectivo\b|colectivos|bondi(s)?\b|\bl[ií]nea\s*\d+\b|\bmicro\b|\bmicros\b/i.test(pregunta)) {
    const colectivo = await consultarColectivoEnVivo(pregunta);
    if (colectivo) {
      partes.push(
        `\n== BÚSQUEDA WEB EN VIVO — COLECTIVOS (${colectivo.deCache ? "resultado en caché, buscado" : "recién buscado"} el ${colectivo.buscadoEn}) ==\n${colectivo.texto}\nEsto viene de una búsqueda web real (no es un dato fijo cargado a mano). Aclará que conviene confirmar recorrido/frecuencia exacta antes de viajar, porque esto puede cambiar.`
      );
    }
  }

  // Si preguntan por el Diferencial, calculamos la próxima salida real.
  if (/diferencial|preferencial/i.test(pregunta)) {
    const ahora = new Date();
    const dif = proximoDiferencial(ahora);
    let texto = `\n== SERVICIO DIFERENCIAL (calculado ahora, hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==\nCircula ${DIFERENCIAL.dias}, una sola vuelta por día, parando solo en ${DIFERENCIAL.paradas.join(", ")}. Precio: $${DIFERENCIAL.precio} (tarifa única, sin descuento social).\nHorario Once→Moreno: sale Once ${DIFERENCIAL.haciaMoreno.Once}, Haedo ${DIFERENCIAL.haciaMoreno.Haedo}, Merlo ${DIFERENCIAL.haciaMoreno.Merlo}, llega Moreno ${DIFERENCIAL.haciaMoreno.Moreno}.\nHorario Moreno→Once: sale Moreno ${DIFERENCIAL.haciaOnce.Moreno}, Merlo ${DIFERENCIAL.haciaOnce.Merlo}, Haedo ${DIFERENCIAL.haciaOnce.Haedo}, llega Once ${DIFERENCIAL.haciaOnce.Once}.\n`;
    if (!dif.circulaHoy) {
      texto += `Hoy no circula: ${dif.motivo}.`;
    } else if (!dif.hora) {
      texto += `Hoy ${dif.motivo}.`;
    } else {
      texto += `Próxima salida hoy: desde ${dif.desde} hacia ${dif.hacia} a las ${dif.hora} (en ${dif.enMinutos} min).`;
    }
    partes.push(texto);
  }

  // Si preguntan por noticias, la fuente de verdad es si el sitio tiene
  // activada la sección de noticias (campo mostrarTitulares en Firestore,
  // el mismo toggle que usa el admin del sitio).
  if (/\bnoticia(s)?\b/i.test(pregunta)) {
    const activas = estado?.mostrarTitulares === true;
    partes.push(`
== NOTICIAS ==
${
  activas
    ? `La sección de noticias del sitio está activa ahora mismo. Sugerí entrar a https://trensarmientoenlinea.com.ar/#noticias para ver los últimos titulares. No inventes ni resumas ninguna noticia puntual, no la tenés cargada acá — solo derivá al link.`
    : `La sección de noticias del sitio está desactivada por ahora (no hay titulares publicados). NO menciones la sección de noticias ni uses el link #noticias — sugerí directamente entrar a https://trensarmientoenlinea.com.ar para lo último del servicio.`
}`);
  }

  // Si la pregunta menciona una o más estaciones, calculamos horarios reales
  // de HOY para CADA UNA (antes solo tomaba la primera y omitía el resto).
  const estacionesDetectadas = detectarEstaciones(pregunta);
  if (estacionesDetectadas.length) {
    const ahora = new Date();
    for (const estacion of estacionesDetectadas) {
      const ultimos = ultimosTrenes(ahora);
      const transporte = infoTransporteEstacion(estacion.name);
      partes.push(`
== TRANSPORTE EN LA ZONA DE "${estacion.name}" ==
${transporte || "Sin datos de colectivos/subte cargados para esta estación."}`);

      // Servicio limitado vigente: una estación fuera del tramo no tiene trenes
      // ahora; no se le da ningún horario del cronograma.
      const idxEstLimitado = idxEstacion(estacion.name);
      if (tramoLimitado && idxEstLimitado >= 0 && !tramoIncluye(tramoLimitado, idxEstLimitado)) {
        partes.push(`
== ${estacion.name.toUpperCase()}: SIN SERVICIO AHORA (servicio limitado) ==
Por el servicio limitado solo circulan trenes entre ${tramoLimitado.desde} y ${tramoLimitado.hasta}. Desde/hacia ${estacion.name} NO circulan trenes ahora. No des ningún horario del cronograma para esta estación ni digas que salen trenes; explicá que está sin servicio hasta que se normalice.`);
        continue;
      }

      // Preferimos datos EN VIVO del proxy (respetan servicio limitado /
      // recorrido acortado, con destino real); si no hay, cae a la grilla
      // fija del cronograma (recorrido completo).
      let vivos = null;
      try {
        vivos = await arribosVivosEstacion(estacion.name);
      } catch (err) {
        console.error("Error trayendo arribos en vivo para", estacion.name, err.message);
      }

      if (vivos && (vivos.haciaMoreno.length || vivos.haciaOnce.length)) {
        const fmt = (arr) => arr.map((t) => `${t.hora} → ${t.destino} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy con datos en vivo";
        partes.push(`
== PRÓXIMOS TRENES EN VIVO PARA "${estacion.name}" (app Trenes Argentinos, ahora mismo, hora Buenos Aires: ${horaArgentinaTexto(ahora)}) ==
Hacia Moreno: ${fmt(vivos.haciaMoreno)}
Hacia Once: ${fmt(vivos.haciaOnce)}
IMPORTANTE: el destino de cada tren es el REAL de hoy (puede no llegar hasta Moreno/Once si el servicio está limitado) — decí exactamente hasta dónde llega cada uno, no asumas el recorrido completo. Esta es la fuente más precisa disponible — no derives a la app si esta sección ya responde la pregunta.`);
      } else {
        const proximos = proximosTrenesEnEstacion({ estacionId: estacion.id, ahora });
        partes.push(`
== HORARIOS REALES CALCULADOS AHORA PARA "${estacion.name}" (cronograma oficial, hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==
Próximos trenes hacia Moreno desde ${estacion.name}: ${proximos.haciaMoreno.map((t) => `${t.hora} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy"}
Próximos trenes hacia Once desde ${estacion.name}: ${proximos.haciaOnce.map((t) => `${t.hora} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy"}
Último tren de hoy (${ultimos.diaTipo === "lv" ? "día hábil" : ultimos.diaTipo === "sab" ? "sábado" : "domingo/feriado"}) saliendo de Once: ${ultimos.desdeOnce.ultimo} (penúltimo: ${ultimos.desdeOnce.penultimo})
Último tren de hoy saliendo de Moreno: ${ultimos.desdeMoreno.ultimo} (penúltimo: ${ultimos.desdeMoreno.penultimo})
${tramoLimitado ? `ATENCIÓN: HAY SERVICIO LIMITADO VIGENTE (solo circulan trenes entre ${tramoLimitado.desde} y ${tramoLimitado.hasta}). Los horarios de arriba son del cronograma normal y NO valen para hoy: no los des como si los trenes salieran; decí que el servicio está limitado y hasta dónde llegan los trenes.\n` : ""}IMPORTANTE: esto es el cronograma habitual (recorrido completo Once–Moreno) — si hay una sección "RECORRIDO REAL DE HOY" o "PRÓXIMOS TRENES EN VIVO" en otra parte del contexto, esa manda por sobre esto porque puede haber servicio limitado hoy. Estos horarios no derives a la app si esta sección ya responde la pregunta.`);
      }

      // Siempre se da el cronograma COMPLETO de locales de la estación (todos los
      // horarios del día, hayan pasado o no); los próximos se marcan aparte.
      const locales = proximosLocales(estacion.name, ahora);
      const todosLosHorarios = horariosLocalesEstacion(estacion.name, ahora);
      const porDia = horariosLocalesEstacionTodosLosDias(estacion.name);
      const nombreDia = { lv: "lunes a viernes", sab: "sábados", dom: "domingos y feriados" };
      const diaHoy = getDayType(ahora);
      const fmt = (arr) => arr.map((l) => `${l.hora} ${l.direccion}`).join(", ");
      let bloqueLocales;
      if (!Object.values(porDia).some((a) => a.length)) {
        bloqueLocales = `Esta estación NO tiene servicios "locales" designados en ningún día (los locales salen de Flores, Liniers, Merlo y Castelar). Puede tomar cualquier tren regular con los horarios de arriba.`;
      } else {
        const otros = Object.keys(porDia).filter((d) => d !== diaHoy && porDia[d].length).map((d) => `${nombreDia[d]}: ${fmt(porDia[d])}`);
        const proxTxt = locales.length ? `Los que todavía no salieron hoy: ${locales.map((l) => `${l.hora} ${l.direccion} (en ${l.enMinutos} min)`).join(", ")}.` : `Hoy ya salieron todos.`;
        bloqueLocales =
          `CRONOGRAMA COMPLETO de locales de ${estacion.name} para HOY (${nombreDia[diaHoy]}): ${todosLosHorarios.length ? fmt(todosLosHorarios) : "hoy no tiene locales en esta estación"}.\n` +
          `${proxTxt}\n` +
          (otros.length ? `Otros días — ${otros.join(" | ")}.\n` : "") +
          `Al responder, dá SIEMPRE el cronograma completo de hoy (todos los horarios, aunque ya hayan pasado); no lo recortes a los próximos.`;
      }
      partes.push(`
== "LOCALES" (formaciones que arrancan VACÍAS) EN "${estacion.name}" ==
IMPORTANTE: un "local" NO es cualquier tren que pasa por la estación — es una formación puntual que arranca vacía ahí mismo, muy buscada porque conviene subirse antes de que se llene.
${bloqueLocales}`);
      // Estado en vivo de los locales de la estación: ya salió / en andén esperando / aún no llegó.
      if (/\blocal(es)?\b/i.test(pregunta)) {
        const enVivo = await estadoLocalesParaBot({ estacion: estacion.name, pregunta, ahora }).catch((err) => { console.error("Error armando estado de locales:", err.message); return null; });
        if (enVivo) partes.push(enVivo);
      }
    }
  } else if (/\blocal(es)?\b/i.test(pregunta)) {
    // Preguntan por "locales" sin decir de qué estación — les paso el listado completo de hoy.
    const ahora = new Date();
    const diaHoy = getDayType(ahora);
    const nombreDia = { lv: "lunes a viernes", sab: "sábados", dom: "domingos y feriados" }[diaHoy];
    const porEstacion = {};
    for (const l of LOCALES[diaHoy]) (porEstacion[l.estacion] ||= []).push(`${l.hora} ${l.direccion === "moreno" ? "hacia Moreno" : "hacia Once"}`);
    const estaciones = Object.keys(porEstacion);
    partes.push(`
== CRONOGRAMA COMPLETO DE "LOCALES" DE HOY (${nombreDia}; hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==
IMPORTANTE: un "local" es una formación que arranca VACÍA en esa estación puntual (no cualquier tren de paso). En días hábiles hay locales en Flores, Liniers, Merlo y Castelar; sábados y domingos solo en Castelar, de madrugada.
${estaciones.length ? estaciones.map((est) => `${est}: ${porEstacion[est].join(", ")}`).join("\n") : "Hoy no hay locales programados."}
Esta es la lista completa del día, incluidos los que ya salieron: dala completa (no la recortes a los próximos) y no derives a la app, esto ya responde la pregunta.`);
    const enVivo = await estadoLocalesParaBot({ estacion: null, pregunta, ahora }).catch((err) => { console.error("Error armando estado de locales:", err.message); return null; });
    if (enVivo) partes.push(enVivo);
  } else if (/último|ultimo|primer(o)?\s+tren|primeros?\s+servicios?/i.test(pregunta)) {
    // Preguntan por el primer/último tren sin decir de qué estación — les doy
    // el horario real de las terminales (Once y Moreno), que es lo más útil.
    const ahora = new Date();
    const ext = ultimosTrenes(ahora);
    const tipoDia = ext.diaTipo === "lv" ? "día hábil" : ext.diaTipo === "sab" ? "sábado" : "domingo/feriado";
    partes.push(`
== PRIMER Y ÚLTIMO TREN DE HOY (calculado ahora, ${tipoDia}, cronograma oficial real) ==
IMPORTANTE: el servicio NO es 24 horas continuas — hay un corte real en la madrugada. Esta es la info exacta, no derives a la app.
Desde Once: primer tren ${ext.desdeOnce.primero} hs, último tren ${ext.desdeOnce.ultimo} hs (penúltimo ${ext.desdeOnce.penultimo} hs).
Desde Moreno: primer tren ${ext.desdeMoreno.primero} hs, último tren ${ext.desdeMoreno.ultimo} hs (penúltimo ${ext.desdeMoreno.penultimo} hs).
Si preguntan por una estación intermedia puntual, avisá que el horario ahí es un poco después del de Once (yendo hacia Moreno) o un poco después del de Moreno (yendo hacia Once), y sugerí preguntar mencionando esa estación para el cálculo exacto.`);
  }

  return partes.join("\n");
}

bot.start((ctx) =>
  ctx.reply(
    "¡Hola! Soy el asistente del Tren Sarmiento 🚆. Preguntame por horarios, frecuencias, tarifas, estado del servicio o combinaciones con otros transportes del AMBA. En el grupo, mencioná mi usuario o respondeme un mensaje para que te vea.\n\nOjo: los mensajes que me escribas por acá (chat privado) quedan registrados para mantenimiento y monitoreo del bot."
  )
);

bot.help((ctx) =>
  ctx.reply(
    "Ejemplos:\n- ¿Cada cuánto pasa el tren en hora pico?\n- ¿Cuánto sale el boleto?\n- ¿Cómo va el servicio ahora?\n- ¿Con qué combina en Once?"
  )
);

// Lista de administradores habilitados para /estado — separada de
// ADMIN_TELEGRAM_ID (que sigue siendo el único destinatario de /informe y
// de los avisos automáticos). Pensada para sumar gente sin tocar código:
// ESTADO_ADMIN_IDS="123456,789012". Si no está seteada, cae a ADMIN_TELEGRAM_ID.
// ADMIN_TELEGRAM_ID siempre queda adentro, se pise o no ESTADO_ADMIN_IDS —
// así nunca corre riesgo de auto-excluirse al sumar gente ahí. Acepta
// tanto IDs numéricos como @usuarios (por si no se consigue el ID numérico
// de un colaborador de confianza).
function esAdminEstado(ctx) {
  const lista = `${process.env.ESTADO_ADMIN_IDS || ""},${process.env.ADMIN_TELEGRAM_ID || ""}`
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const porId = lista.includes(String(ctx.from?.id).toLowerCase());
  const porUsername = ctx.from?.username && lista.includes(ctx.from.username.toLowerCase());
  return porId || porUsername;
}

// Comando privado (solo admin del estado): "/decir <instrucción>" — el bot
// interpreta la instrucción con el mismo motor que usa para responder
// preguntas normales (horarios, locales, tarifas, etc.) y PUBLICA la
// respuesta en el grupo, en vez de contestarle al admin. Ej:
// "/decir responde los locales de moreno" → el bot publica en el grupo la
// respuesta real sobre los locales de Moreno, como si alguien hubiera
// preguntado ahí.
// Lista los temas (topics) del grupo donde el bot ya respondió antes, para
// no tener que ir a buscar el ID a mano cada vez que se usa /decir.
bot.command("temas", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const temas = await listarTemasRecientes(30);
  if (!temas.length) {
    await ctx.reply(
      "No tengo ningún tema registrado todavía (el bot nunca respondió con éxito dentro de un tema en los últimos 30 días). Probá el método manual con getUpdates, o esperá a que alguien lo mencione dentro de un tema."
    );
    return;
  }

  const lineas = temas
    .slice(0, 15)
    .map((t) => {
      const fecha = new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(t.ultimaFecha));
      return `🧵 ID ${t.temaId} — ${t.cantidad} respuesta(s), última el ${fecha}\n   "${t.ultimaPregunta}"`;
    })
    .join("\n\n");

  await ctx.reply(`Temas donde el bot respondió antes (últimos 30 días):\n\n${lineas}`);
});

bot.command("decir", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const partes = (ctx.message.text || "").split(" ").slice(1);
  // Si el primer "parámetro" es un número, lo tomamos como el ID del tema
  // (topic) donde publicar. Si no, publica en General (puede fallar si ese
  // tema está cerrado — Telegram no deja elegir otro tema por default).
  let temaId = null;
  if (partes.length && /^\d+$/.test(partes[0])) {
    temaId = partes.shift();
  }
  const instruccion = partes.join(" ").trim();

  if (!instruccion) {
    await ctx.reply(
      'Uso: /decir [id_tema] <instrucción>\n\n' +
        'Ej: "/decir responde los locales de moreno" — publica en General.\n' +
        'Ej: "/decir 33551 responde los locales de moreno" — publica en el tema 33551.\n\n' +
        'Para conseguir el ID de un tema: mantené apretado el nombre del tema en el grupo → "Copiar enlace" → el número al final del link (.../c/xxxxx/AQUÍ) es el ID.'
    );
    return;
  }

  const grupoId = process.env.ALLOWED_GROUP_ID;
  if (!grupoId) {
    await ctx.reply("Falta configurar ALLOWED_GROUP_ID en Render para saber en qué grupo publicar.");
    return;
  }

  try {
    await ctx.sendChatAction("typing");
    const contexto = await armarContexto(instruccion);
    const respuestaCruda = await responderPregunta({ pregunta: instruccion, contexto });
    // true = si no tiene un dato concreto, que lo diga con honestidad en
    // vez de quedarse callado — acá SÍ queremos que publique algo siempre,
    // ya que lo pediste vos explícitamente.
    const respuesta = manejarSinRespuesta(respuestaCruda, true);

    const opciones = temaId ? { message_thread_id: Number(temaId) } : undefined;
    await bot.telegram.sendMessage(grupoId, respuesta, opciones);
    await ctx.reply(`✅ Publicado en el grupo${temaId ? ` (tema ${temaId})` : ""}:\n\n${respuesta}`);
  } catch (err) {
    console.error("Error en /decir:", err.message);
    const motivo = err.response?.description || err.message;
    if (/TOPIC_CLOSED/i.test(motivo)) {
      await ctx.reply(
        "El tema donde intenté publicar está cerrado. Pasame el ID de un tema abierto: /decir <id_tema> <instrucción>. Para sacarlo: mantené apretado el nombre del tema → \"Copiar enlace\" → el número al final es el ID."
      ).catch(() => {});
    } else {
      await ctx.reply("No pude generar/publicar la respuesta: " + motivo).catch(() => {});
    }
  }
});

// Lista APARTE (no mezclar con esAdminEstado, que da permiso de cambiar el
// semáforo oficial) para quién puede disparar el análisis automático de
// imágenes de comunicados. Acepta tanto IDs numéricos como @usuarios, para
// no depender de conseguir el ID numérico de cada colaborador.
// Variable: COLABORADORES_IMAGENES="123456,@vivigo81,@otrocolaborador"
function esColaboradorImagenes(ctx) {
  const lista = `${process.env.COLABORADORES_IMAGENES || ""},${process.env.ADMIN_TELEGRAM_ID || ""}`
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const porId = lista.includes(String(ctx.from?.id).toLowerCase());
  const porUsername = ctx.from?.username && lista.includes(ctx.from.username.toLowerCase());
  return porId || porUsername;
}

const ESTADOS_VALIDOS = { normal: "normal", demoras: "modificado", paro: "paro" };
const ETIQUETAS_CONFIRMACION = {
  normal: "Servicio normal",
  modificado: "Servicio con demoras",
  paro: "Servicio interrumpido",
};

bot.command("estado", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const partes = (ctx.message.text || "").split(" ").slice(1);
  const subcomando = (partes[0] || "").toLowerCase();
  const mensaje = partes.slice(1).join(" ").trim();

  if (!ESTADOS_VALIDOS[subcomando]) {
    await ctx.reply(
      "Uso: /estado <normal|demoras|paro> [mensaje]\n\nEj: /estado demoras Demoras de 15-20 min por falla de señales en Ramos Mejía"
    );
    return;
  }
  if (subcomando !== "normal" && !mensaje) {
    await ctx.reply(`Falta el mensaje para "${subcomando}". Ej: /estado ${subcomando} Demoras de 15-20 min en Ramos Mejía`);
    return;
  }

  try {
    const estado = ESTADOS_VALIDOS[subcomando];
    await actualizarEstadoServicio({ estado, mensaje, editor: "Telegram (HG)" });
    const etiqueta = ETIQUETAS_CONFIRMACION[estado];
    await ctx.reply(`✅ Estado actualizado: ${etiqueta}${mensaje ? ` — "${mensaje}"` : ""}`);
  } catch (err) {
    console.error("Error actualizando estado:", err.message);
    await ctx.reply("No pude actualizar el estado: " + err.message);
  }
});

// Modo silencio: el bot deja de publicar en el grupo, pero sigue procesando
// todo y le manda al admin por privado lo que habría respondido/escrito.
// /hablar lo saca del silencio. Los comandos del admin (ej. /decir) siguen
// publicando en el grupo. Solo admin; la confirmación va siempre por privado.
async function confirmarAlAdmin(texto) {
  await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto).catch((err) => console.error("Error confirmando al admin:", err.message));
}

bot.command("silencio", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const yaEstaba = estaSilenciado();
  await setSilencio(true, `admin ${ctx.from.id}`);
  await confirmarAlAdmin(
    yaEstaba
      ? "🔇 Ya estaba en silencio. /hablar para volver a responder en el grupo."
      : "🔇 Silencio activado. El bot deja de publicar en el grupo y te manda a vos por privado lo que habría respondido o escrito (con quién preguntó y qué). Tus comandos como /decir siguen publicando. /hablar para volver."
  );
});

bot.command("hablar", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const estaba = estaSilenciado();
  await setSilencio(false, `admin ${ctx.from.id}`);
  await confirmarAlAdmin(estaba ? "🔊 Silencio desactivado. El bot vuelve a responder en el grupo." : "🔊 El bot ya estaba hablando (no estaba en silencio).");
});

// EXPERIMENTAL (solo admin): consulta los datos de la app de Trenes Argentinos
// vía el proxy comunitario de ariedro y responde SIEMPRE por privado.
//   /apptrenes Moreno            -> estado/demoras/cancelaciones de Sarmiento en esa estación
//   /apptrenes scan [completo]   -> barrido de las 16 estaciones; "completo" lista todo, no solo lo anormal
//   /apptrenes auto on|off       -> chequeo automatico de 5 min manda el barrido completo (incidentes)
//   /apptrenes get /ruta?x=y     -> GET crudo al proxy (para probar rutas, ej. alertas)
// Tabla tipo "tablero de estación" (andén | hora | destino | estado) para
// una cabecera (Once o Moreno). Usa los datos reales de appTrenes.js — el
// formateo de tabla lo hace Gemini, pero los números son 100% del proxy,
// nunca los toca el modelo.
// Arma el texto del tablero (usado por /tablero y /tablerogrupo). Devuelve
// { texto, error } — si hay error, mostrarlo tal cual, no hay tabla.
// Arma la IMAGEN del tablero (dibujada con código, no con IA) — datos
// exactos, estilo calcado del cartel real de Trenes Argentinos.
async function armarImagenTablero(estacion) {
  const { filas, revisadas, error } = await filasParaTabla(estacion, 5);
  if (error) return { buffer: null, error };
  if (!filas.length) {
    return { buffer: null, error: `Sin servicios de Sarmiento saliendo de ${estacion} en este momento.` };
  }
  const origenNombre = revisadas[0] || estacion;
  const buffer = generarImagenTablero(filas, origenNombre, horaArgentinaTexto(new Date()));
  return { buffer, error: null, origenNombre };
}

// Respuesta automática a "¿cómo están saliendo los trenes de Once?": comparte
// el tablero de Once (imagen con datos reales) y deja el ancla del tablero en
// vivo del sitio. Devuelve true si respondió, false si no pudo (en ese caso el
// flujo normal con Gemini contesta como siempre).
async function responderConTableroOnce(ctx) {
  try {
    const tramo = await getTramoLimitado().catch(() => null);
    const nota = tramo ? `\n🚧 Servicio limitado: solo circulan trenes entre ${tramo.desde} y ${tramo.hasta}.` : "";
    const cierre = `\n\n📲 Tablero en vivo, se actualiza solo: ${LINK_TABLERO}`;
    await ctx.sendChatAction("upload_photo").catch(() => {});
    const { buffer, error } = await armarImagenTablero("Once");
    if (buffer) {
      await ctx.replyWithPhoto(
        { source: buffer },
        { caption: `🚉 Así están saliendo los trenes de Once (${horaArgentinaTexto(new Date())}).${nota}${cierre}`, ...opcionesRespuesta(ctx) }
      );
      return true;
    }
    // Sin salidas (p. ej. servicio limitado que no incluye Once): eso ES la respuesta.
    if (error && /servicio limitado|sin servicio|no salen|sin servicios/i.test(error)) {
      await ctx.reply(`${error}${cierre}`, opcionesRespuesta(ctx));
      return true;
    }
    return false;
  } catch (err) {
    console.error("Error en respuesta automática con tablero de Once:", err.message);
    return false;
  }
}

// Tablero de estación INTERMEDIA (Morón, Castelar, etc.) estilo "PRÓXIMO
// TREN en X minutos" — distinto al de las cabeceras (Once/Moreno, que usan
// andén). Va por sentido: si no lo especificás, manda las dos imágenes
// (hacia Once y hacia Moreno). Uso: /tableroestacion <estación> [once|moreno]
bot.command("tableroestacion", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const partes = (ctx.message.text || "").replace(/^\/tableroestacion(@\w+)?\s*/i, "").split(" ").filter(Boolean);
  let sentidoPedido = null;
  if (partes.length && /^(once|moreno)$/i.test(partes[partes.length - 1])) {
    sentidoPedido = partes.pop().toLowerCase();
  }
  const nombreEstacion = partes.join(" ").trim();
  if (!nombreEstacion) {
    await ctx.reply("Uso: /tableroestacion <estación> [once|moreno]\nEj: /tableroestacion moron moreno");
    return;
  }

  const estacion = buscarEstacion(nombreEstacion);
  if (!estacion) {
    await ctx.reply(`No encontré la estación "${nombreEstacion}".`);
    return;
  }

  try {
    await ctx.sendChatAction("upload_photo");
    const ahora = new Date();
    const horaTexto = horaArgentinaTexto(ahora);

    // Preferimos datos EN VIVO del proxy (respetan servicio limitado/
    // recorrido acortado); si el proxy no tiene nada, caemos a la grilla
    // fija del cronograma (recorrido completo, como hasta ahora).
    const vivos = await arribosVivosEstacion(estacion.name).catch(() => null);
    if (vivos?.fueraDeTramo) {
      await ctx.reply(`🚧 Servicio limitado: hoy solo circulan trenes entre ${vivos.servicioLimitado.desde} y ${vivos.servicioLimitado.hasta}. En ${estacion.name} no hay trenes por ahora.`);
      return;
    }
    let proximos;
    if (vivos && (vivos.haciaMoreno.length || vivos.haciaOnce.length)) {
      proximos = vivos;
    } else {
      proximos = proximosTrenesEnEstacion({ estacionId: estacion.id, ahora, sentido: sentidoPedido });
    }

    const sentidos = [];
    if (sentidoPedido !== "once" && proximos.haciaMoreno.length) sentidos.push({ nombre: "Moreno", datos: proximos.haciaMoreno });
    if (sentidoPedido !== "moreno" && proximos.haciaOnce.length) sentidos.push({ nombre: "Once", datos: proximos.haciaOnce });

    if (!sentidos.length) {
      await ctx.reply(`No quedan más trenes hoy en ${estacion.name} para ese sentido.`);
      return;
    }

    for (const s of sentidos) {
      const buffer = generarImagenProximoTren(estacion.name, s.nombre, s.datos, horaTexto);
      await ctx.replyWithPhoto({ source: buffer }, { caption: `🚉 ${estacion.name} — sentido ${s.nombre}` });
    }
  } catch (err) {
    console.error("Error en /tableroestacion:", err.message);
    await ctx.reply("No pude armar el tablero: " + err.message).catch(() => {});
  }
});

// /tablero [estación]            → tablero de ahora (Once por defecto)
// /tablero 10 [estación]         → cómo estaba el tablero hace 10 minutos
// (también /tablero moreno 10). Hasta 180 min hacia atrás; el bot guarda una
// foto cada ~5 min, así que se muestra la más cercana y se aclara su hora real.
bot.command("tablero", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const partes = (ctx.message.text || "").replace(/^\/tablero(@\w+)?\s*/i, "").split(/\s+/).filter(Boolean);
  let minutos = null;
  const resto = [];
  for (const p of partes) {
    const m = /^(\d{1,3})(?:m|min|mins|minutos)?$/i.exec(p);
    if (m && minutos == null) minutos = Number(m[1]);
    else resto.push(p);
  }
  const estacion = resto.join(" ").trim() || "Once";

  try {
    await ctx.sendChatAction("upload_photo");

    if (minutos && minutos > 0) {
      if (minutos > 180) {
        await ctx.reply("Guardo las fotos del tablero por 3 horas, así que puedo ir hasta /tablero 180.");
        return;
      }
      const est = buscarEstacion(estacion);
      const cabecera = est && /^(once|moreno)$/i.test(est.name) ? est.name : /^(once|moreno)$/i.test(estacion) ? estacion : null;
      if (!cabecera) {
        await ctx.reply("El tablero histórico existe para las cabeceras: /tablero 10 once  o  /tablero 10 moreno.");
        return;
      }
      const clave = cabecera[0].toUpperCase() + cabecera.slice(1).toLowerCase();
      const res = await snapshotHaceMinutos(minutos);
      if (!res || !res.dentroDeTolerancia) {
        const rango = await rangoRegistrado();
        const h = (ts) => horaArgentinaTexto(new Date(ts));
        await ctx.reply(
          `No tengo una foto del tablero de hace ${minutos} min` +
            (res ? ` (la más cercana es de las ${h(res.foto.ts)}, a ${res.diferenciaMin} min de lo que pedís).` : ".") +
            (rango ? `\nTengo registros entre las ${h(rango.desde)} y las ${h(rango.hasta)}.` : "\nTodavía no hay registros guardados (se empiezan a guardar con el chequeo periódico, cada ~5 min).")
        );
        return;
      }
      const { foto } = res;
      const cab = foto.cabeceras?.[clave];
      const horaFoto = horaArgentinaTexto(new Date(foto.ts));
      const haceReal = Math.max(0, Math.round((Date.now() - foto.ts) / 60000));
      const limitado = foto.servicioLimitado ? `\n🚧 Había servicio limitado: solo circulaban trenes entre ${foto.servicioLimitado.desde} y ${foto.servicioLimitado.hasta}.` : "";
      if (!cab || !cab.filas?.length) {
        await ctx.reply(`🕒 Tablero de ${clave} a las ${horaFoto} (hace ${haceReal} min):\n${cab?.error || `Sin servicios de Sarmiento saliendo de ${clave} en ese momento.`}${limitado}`);
        return;
      }
      const buffer = generarImagenTablero(cab.filas, cab.origenNombre || clave, horaFoto, {
        etiquetaHora: "HORA DEL REGISTRO",
        pie: `Registro de las ${horaFoto} (hace ${haceReal} min) — no es en vivo`,
      });
      await ctx.replyWithPhoto({ source: buffer }, { caption: `🕒 Tablero — ${clave} a las ${horaFoto} (hace ${haceReal} min)${limitado}` });
      return;
    }

    const { buffer, error, origenNombre } = await armarImagenTablero(estacion);
    if (error) {
      await ctx.reply(error);
      return;
    }
    await ctx.replyWithPhoto({ source: buffer }, { caption: `🚉 Tablero — ${origenNombre}` });
  } catch (err) {
    console.error("Error en /tablero:", err.message);
    await ctx.reply("No pude armar el tablero: " + err.message).catch(() => {});
  }
});

// Igual que /tablero, pero PUBLICA el resultado en el grupo en vez de
// contestarte a vos. Mismo patrón que /decir: si el primer parámetro es un
// número, es el ID del tema (si no lo ponés, publica en General — puede
// fallar si ese tema está cerrado, usá /temas para conseguir uno abierto).
// Uso: /tablerogrupo [id_tema] [estación]
bot.command("tablerogrupo", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const partes = (ctx.message.text || "").replace(/^\/tablerogrupo(@\w+)?\s*/i, "").split(" ").filter(Boolean);
  let temaId = null;
  if (partes.length && /^\d+$/.test(partes[0])) temaId = partes.shift();
  const estacion = partes.join(" ").trim() || "Once";

  const grupoId = process.env.ALLOWED_GROUP_ID;
  if (!grupoId) {
    await ctx.reply("Falta configurar ALLOWED_GROUP_ID en Render para saber en qué grupo publicar.");
    return;
  }

  try {
    await ctx.sendChatAction("upload_photo");
    const { buffer, error, origenNombre } = await armarImagenTablero(estacion);
    if (error) {
      await ctx.reply(error);
      return;
    }

    const opciones = {
      caption: `🚉 Tablero — ${origenNombre}`,
      ...(temaId ? { message_thread_id: Number(temaId) } : {}),
    };
    await bot.telegram.sendPhoto(grupoId, { source: buffer }, opciones);
    await ctx.reply(`✅ Tablero publicado en el grupo${temaId ? ` (tema ${temaId})` : ""}.`);
  } catch (err) {
    console.error("Error en /tablerogrupo:", err.message);
    const motivo = err.response?.description || err.message;
    if (/TOPIC_CLOSED/i.test(motivo)) {
      await ctx.reply(
        'El tema donde intenté publicar está cerrado. Pasame el ID de un tema abierto: /tablerogrupo <id_tema> [estación]. Usá /temas para ver temas conocidos.'
      ).catch(() => {});
    } else {
      await ctx.reply("No pude publicar el tablero: " + motivo).catch(() => {});
    }

  }
});

bot.command("estadoauto", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const arg = ((ctx.message.text || "").split(" ")[1] || "").toLowerCase();
  if (arg === "on" || arg === "off") await setEstadoAuto(arg === "on", `admin ${ctx.from.id}`);
  const actual = await getEstadoServicio().catch(() => null);
  await bot.telegram
    .sendMessage(
      process.env.ADMIN_TELEGRAM_ID,
      `🚦🤖 Semáforo automático: ${estadoAutoActivo() ? "ACTIVO" : "apagado"}${actual ? `\nSitio ahora: ${actual.etiqueta} — "${actual.mensaje}"` : ""}\n\nUso: /estadoauto on | off`
    )
    .catch((err) => console.error("Error en /estadoauto:", err.message));
});

bot.command("locales", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  try {
    const texto = await reporteLocales();
    for (let i = 0; i < texto.length; i += 3900) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto.slice(i, i + 3900)).catch((err) => console.error("Error en /locales:", err.message));
    }
  } catch (err) {
    await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, `No pude armar /locales: ${err.message}`).catch(() => {});
  }
});

bot.command("apptrenes", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const enviar = async (texto) => {
    for (let i = 0; i < texto.length; i += 3900) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto.slice(i, i + 3900)).catch((err) => console.error("Error en /apptrenes:", err.message));
    }
  };
  const args = (ctx.message.text || "").replace(/^\/apptrenes(@\w+)?\s*/i, "").trim();
  if (!args) {
    await enviar(
      "Uso:\n" +
        "/apptrenes Moreno → Sarmiento en esa estación (estado, demoras, cancelaciones, leyendas)\n" +
        "/apptrenes scan → barrido de las 16 estaciones del ramal, muestra solo lo anormal\n" +
        "/apptrenes salidas Once (o Moreno) → próximas salidas de esa cabecera, con andén si el proxy lo trae\n" +
        "/apptrenes origenes → trenes que declaran salir de una estación distinta a la habitual (ej. locales saliendo de Liniers en vez de Flores)\n" +
        "/apptrenes scan completo → lo mismo pero lista TODOS los servicios de TODAS las estaciones\n" +
        "/apptrenes auto on|off → activa/desactiva que el chequeo automático de cada 5 min te mande el barrido completo por privado (usalo durante un incidente puntual)\n" +
        "/apptrenes get /infraestructura/estaciones?nombre=Once → consulta cruda al proxy (para probar rutas, por ej. alertas)"
    );
    return;
  }
  try {
    if (/^origenes$/i.test(args)) {
      const barrido = await barridoEstructurado({ forzar: true });
      const inusuales = trenesConOrigenInusual(barrido.todos);
      if (!inusuales.length) {
        await enviar("Ningún tren declara salir de una estación distinta a Once/Flores/Merlo/Moreno en este momento.");
      } else {
        const lineas = inusuales.map((item) => {
          const d = datosServicio(item);
          return `• #${d.s.numero ?? "?"} → ${d.destino} | sale de ${d.origenReal} (visto en ${d.est.nombre}) · prog ${hora(d.prog)}${d.anden ? ` · andén ${d.anden}` : ""}`;
        });
        await enviar(`🔀 Trenes con origen distinto al habitual:\n\n${lineas.join("\n")}`);
      }
    } else if (/^salidas\s+/i.test(args)) {
      const { texto } = await proximasSalidas(args.replace(/^salidas\s+/i, "").trim());
      await enviar(texto);
    } else if (/^scan(\s+completo)?$/i.test(args)) {
      await enviar(await barridoSarmiento({ completo: /completo/i.test(args) }));
    } else if (/^auto\s+(on|off)$/i.test(args)) {
      const on = /on$/i.test(args);
      await setEscaneoCompleto(on, `admin ${ctx.from.id}`);
      await enviar(
        on
          ? "🟢 Escaneo automático completo ACTIVADO: cada ~5 min (junto con el chequeo de cancelaciones) te mando el barrido completo de las 16 estaciones por privado. Recordá apagarlo con /apptrenes auto off cuando termine el incidente, para no saturarte de mensajes."
          : "🔴 Escaneo automático completo DESACTIVADO. El chequeo cada 5 min sigue avisando solo cancelaciones nuevas, como antes."
      );
    } else if (/^get\s+/i.test(args)) {
      const ruta = args.replace(/^get\s+/i, "").trim();
      const data = await consultarProxy(ruta);
      const texto = typeof data === "string" ? data : JSON.stringify(data);
      await enviar(`GET ${ruta}\n(${texto.length} caracteres${texto.length > 3500 ? ", recortado" : ""})\n\n${texto.slice(0, 3500)}`);
    } else {
      await enviar(await reporteEstacion(args));
    }
  } catch (err) {
    console.error("Error en /apptrenes:", err.message);
    await enviar(`⚠️ No pude consultar el proxy de la app: ${err.message}`);
  }
});

// Estado en vivo de las formaciones en Once y Moreno: si ya llegó y espera, si ya salió
// (y a qué hora) o si está en camino. Lo alimenta la vigilancia de salidas (vigiaSalidas.js).
// /formaciones informe [hoy|ayer|AAAA-MM-DD|DD/MM] → informe por formación del día (informeFormaciones.js).
bot.command("formaciones", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  try {
    const args = (ctx.message?.text || "").trim().split(/\s+/).slice(1);
    const texto = /^informe$/i.test(args[0] || "") ? await textoInformeFormaciones(args.slice(1).join(" ")) : textoFormaciones();
    for (let i = 0; i < texto.length; i += 3900) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto.slice(i, i + 3900));
    }
  } catch (err) {
    console.error("Error en /formaciones:", err.message);
  }
});

// Asistente de viaje (viaje.js): el admin sube a un tren y el bot lo sigue y le avisa por PRIVADO en cada
// estación, con demora real vs. la que informa la app y los motivos posibles. Nunca escribe en el grupo.
//   /viaje [número | HH:MM] [desde X] [a Y] · /viaje off · /donde (o "¿dónde estoy?")
async function responderViaje(ctx, fn) {
  if (!esAdminEstado(ctx)) return;
  if (ctx.chat?.type !== "private") { await ctx.reply("El asistente de viaje funciona solo por chat privado conmigo."); return; }
  try {
    const texto = await fn();
    if (texto) await ctx.reply(texto.slice(0, 3900));
  } catch (err) {
    console.error("Error en asistente de viaje:", err.message);
    await ctx.reply("⚠️ Falló el asistente de viaje: " + err.message);
  }
}
bot.command("viaje", (ctx) => responderViaje(ctx, () => iniciarViaje({ chatId: ctx.chat.id, texto: (ctx.message?.text || "").replace(/^\/viaje(@\w+)?\s*/i, "") })));
const responderDonde = (ctx) => responderViaje(ctx, async () => (await estadoViaje(ctx.chat.id)) || "No tenés un viaje en curso. Mandá /viaje para empezar (o /viaje ayuda).");
bot.command("donde", responderDonde);
bot.hears(/^\s*¿?\s*d[oó]nde\s+(estoy|voy|vamos|andamos)\s*\??\s*$/i, (ctx, next) => (ctx.chat?.type === "private" && hayViajeActivo(ctx.chat.id) ? responderDonde(ctx) : next()));
// Ubicación (también en tiempo real) que comparte el admin: se compara con la del tren como dato de precisión.
const alRecibirUbicacion = (ctx, msg) => {
  if (ctx.chat?.type !== "private" || !esAdminEstado(ctx) || !msg?.location) return;
  ubicacionUsuario(ctx.chat.id, msg.location.latitude, msg.location.longitude, msg.location.horizontal_accuracy);
};
bot.on("location", (ctx) => alRecibirUbicacion(ctx, ctx.message));
bot.on("edited_message", (ctx, next) => (ctx.editedMessage?.location ? alRecibirUbicacion(ctx, ctx.editedMessage) : next()));

// Estadísticas de la "Validación de Usuario" del mapa de formaciones del sitio (validacionesGps.js).
// /validaciones [días]  → intentos, % que validó, diferencia celular vs. formación y motivos de falla.
bot.command("validaciones", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  try {
    const dias = parseInt((ctx.message?.text || "").trim().split(/\s+/)[1], 10);
    const texto = await textoValidaciones(Number.isFinite(dias) ? dias : 7);
    for (let i = 0; i < texto.length; i += 3900) await ctx.reply(texto.slice(i, i + 3900));
  } catch (err) {
    console.error("Error en /validaciones:", err.message);
    await ctx.reply("⚠️ No pude leer las validaciones: " + err.message);
  }
});

// Servicio limitado a mano. El bot y el tablero dejan de mostrar trenes fuera
// del tramo. Uso:
//   /limitado Liniers Moreno [minutos] [motivo...]   → solo circulan trenes entre esas dos estaciones
//   /limitado                                        → ver el estado actual
//   /limitado off                                    → cerrarlo (la detección automática no lo reactiva por 1 hora)
bot.command("limitado", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const args = (ctx.message.text || "").replace(/^\/limitado(@\w+)?\s*/i, "").trim();
  try {
    if (/^(off|fin|normal|normalizado|cerrar|apagar)\b/i.test(args)) {
      await limpiarTramoLimitado({ suprimirProxy: true });
      olvidarTema("estado");
      await ctx.reply("✅ Servicio limitado cerrado. El bot y el tablero vuelven al recorrido completo (la detección automática no lo reactiva por 1 hora).");
      return;
    }
    if (!args) {
      const t = await getTramoLimitado();
      await ctx.reply(
        t
          ? `🚧 Servicio limitado vigente: solo circulan trenes entre ${t.desde} y ${t.hasta}.\nOrigen: ${t.origen}${t.quien ? ` (${t.quien})` : ""}${t.motivo ? `\nMotivo: ${t.motivo}` : ""}\nVence: ${new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t.venceEn))}${t.vigenciaEstimada ? " (estimado)" : ""}\n\n/limitado off para cerrarlo.`
          : "No hay servicio limitado vigente.\nUso: /limitado Liniers Moreno [minutos] [motivo]"
      );
      return;
    }
    const estaciones = extraerEstaciones(args);
    if (estaciones.length < 2 || estaciones[0] === estaciones[1]) {
      await ctx.reply("Necesito las dos estaciones entre las que SÍ circulan trenes. Ej: /limitado Liniers Moreno 120 accidente en Flores");
      return;
    }
    // minutos: primer número suelto que no sea parte de un nombre de estación
    const mMin = /(?:^|\s)(\d{1,3})(?=\s|$)/.exec(args);
    const duracionMin = mMin ? Number(mMin[1]) : null;
    // motivo: lo que queda después de sacar las dos primeras estaciones, los minutos y conectores sueltos
    let sacadas = 0;
    const motivo = args
      .replace(/san antonio de padua|san antonio|paso del rey|villa luro|ramos mej[ií]a|once|caballito|flores|floresta|liniers|ciudadela|haedo|mor[oó]n|castelar|ituzaing[oó]|padua|merlo|moreno/gi, (m) => (++sacadas <= 2 ? " " : m))
      .replace(/(?:^|\s)\d{1,3}(?=\s|$)/, " ")
      .replace(/^\s*(entre|y|e|solo|s[oó]lo|hasta)\b/i, " ")
      .replace(/\s(entre|y|e|solo|s[oó]lo|hasta)\s/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const quien = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `ID ${ctx.from?.id}`;
    const t = await setTramoLimitado({ estA: estaciones[0], estB: estaciones[1], motivo, duracionMin, origen: "manual", quien });
    if (!t) {
      await ctx.reply("No pude cargar el servicio limitado con esas estaciones.");
      return;
    }
    olvidarTema("estado");
    const vence = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t.venceEn));
    await ctx.reply(`🚧 Servicio limitado cargado: solo circulan trenes entre ${t.desde} y ${t.hasta}, hasta las ${vence}${t.vigenciaEstimada ? " (estimado: no indicaste minutos, son 2 h)" : ""}.\nEl bot y el tablero ya lo respetan. /limitado off para cerrarlo.`);
  } catch (err) {
    console.error("Error en /limitado:", err.message);
    await ctx.reply("No pude gestionar el servicio limitado: " + err.message);
  }
});

// Ver / limpiar los avisos vigentes de la fuente de verdad (por si el
// clasificador entendió mal algo). Uso: /avisos  |  /avisos limpiar
bot.command("avisos", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const sub = ((ctx.message.text || "").split(" ")[1] || "").toLowerCase();
  try {
    if (sub === "limpiar") {
      await cerrarTodosLosAvisos();
      olvidarTema("estado");
      await ctx.reply("✅ Avisos vigentes cerrados. El bot vuelve al estado oficial.");
      return;
    }
    const avisos = await avisosVigentes();
    if (!avisos.length) {
      await ctx.reply("No hay avisos vigentes de la fuente de verdad.");
      return;
    }
    const hora = (iso) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
    await ctx.reply(
      "Avisos vigentes:\n\n" +
        avisos.map((a) => `• [${a.tipo}] ${a.resumen}\n  desde ${hora(a.timestamp)} hasta ${hora(a.venceEn)}${a.vigenciaEstimada ? " (estimado)" : ""}`).join("\n\n") +
        "\n\n/avisos limpiar para cerrarlos."
    );
  } catch (err) {
    console.error("Error en /avisos:", err.message);
    await ctx.reply("No pude gestionar los avisos: " + err.message);
  }
});

// Comando manual para pedir el informe de logs de las últimas 24hs sin
// depender de que el ping externo llegue justo dentro de la ventana de
// las 18hs (si el servicio free de Render está dormido en ese momento,
// el informe automático no dispara). Solo el admin puede usarlo.
bot.command("informe", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  try {
    const texto = await generarInformeTexto();
    await ctx.reply(texto);
  } catch (err) {
    console.error("Error generando informe manual:", err.message);
    await ctx.reply("No pude generar el informe: " + err.message);
  }
});

// Lista mensajes que fallaron por error técnico (Firestore lo guarda aunque
// el log de Render ya haya rotado). Uso: /fallidos [horas] — default 24hs.
bot.command("fallidos", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const horas = parseInt((ctx.message.text || "").split(" ")[1], 10) || 24;
  try {
    const { texto } = await listarFallidosRecientes(horas);
    await ctx.reply(texto);
  } catch (err) {
    console.error("Error listando fallidos:", err.message);
    await ctx.reply("No pude listar los fallidos: " + err.message);
  }
});

// Reintenta a mano los fallidos guardados en Firestore, sin el límite de
// 3hs de la cola automática (retryQueue.js). Uso: /reintentar [horas].
bot.command("reintentar", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  const horas = parseInt((ctx.message.text || "").split(" ")[1], 10) || 24;
  await ctx.reply(`Reintentando fallidos de las últimas ${horas}hs, esto puede tardar un toque...`);
  try {
    const { texto } = await reintentarFallidosGuardados({
      horas,
      generarRespuesta: async (pregunta) => {
        const contexto = await armarContexto(pregunta);
        const respuestaCruda = await responderPregunta({ pregunta, contexto });
        return manejarSinRespuesta(respuestaCruda, true);
      },
      enviarMensaje: ({ chatId, threadId, texto }) =>
        bot.telegram.sendMessage(chatId, texto, threadId ? { message_thread_id: threadId } : undefined),
    });
    await ctx.reply(texto);
  } catch (err) {
    console.error("Error reintentando fallidos:", err.message);
    await ctx.reply("No pude reintentar los fallidos: " + err.message);
  }
});

// Reenvía al admin cualquier foto, audio, nota de voz o video que le
// manden al bot por chat PRIVADO (no en el grupo, ahí es tráfico normal).
// Avisa al admin que llegó una foto/audio/video, SIN reenviar el archivo:
// manda el link (temporal, de Telegram) y, para audio y video, una
// transcripción/descripción hecha con Gemini. transcribir=false se usa
// cuando el audio ya lo va a transcribir otro flujo después (fuente de
// verdad), para no duplicar el trabajo ni el mensaje.
async function reenviarMediaAlAdmin(ctx, tipo, { transcribir = true } = {}) {
  if (!esChatAutorizado(ctx)) return;
  if (!process.env.ADMIN_TELEGRAM_ID) return;
  try {
    const from = ctx.from || {};
    const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
    const origen = ctx.chat?.type === "private" ? "por privado" : `en el grupo (${ctx.chat?.title || "sin nombre"})`;

    const media =
      ctx.message?.photo?.[ctx.message.photo.length - 1] ??
      ctx.message?.voice ??
      ctx.message?.audio ??
      ctx.message?.video ??
      ctx.message?.video_note ??
      null;
    const fileId = media?.file_id ?? null;

    let lineaLink = "";
    if (fileId) {
      try {
        const url = await bot.telegram.getFileLink(fileId);
        // El link de Telegram está garantizado válido por al menos 1 hora
        // (después puede vencer) — es para abrir rápido, no para guardar.
        lineaLink = `\n🔗 ${url.href} (válido ~1 hora)`;
      } catch (err) {
        console.error(`Error generando link de ${tipo}:`, err.message);
      }
    }

    let extra = "";
    if (fileId && transcribir && (ctx.message?.voice || ctx.message?.audio)) {
      extra = await procesarExtraMedia(fileId, media, "audio", (buf, mime) => transcribirAudio(buf.toString("base64"), mime), "🗣️ Transcripción");
    } else if (fileId && (ctx.message?.video || ctx.message?.video_note)) {
      extra = await procesarExtraMedia(fileId, media, "video", (buf, mime) => describirVideo(buf.toString("base64"), mime || "video/mp4"), "🎬 Descripción");
    }

    await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, `📎 Recibí un(a) ${tipo} de ${quien} ${origen}:${lineaLink}${extra}`);
  } catch (err) {
    console.error(`Error avisando ${tipo} al admin:`, err.message);
  }
}

// Descarga el archivo y le pide a Gemini que lo transcriba/describa. Con
// topes de tamaño/duración para no colgarse con archivos grandes.
async function procesarExtraMedia(fileId, media, tipo, fn, etiqueta) {
  const TOPE_SEG = tipo === "audio" ? 300 : 180;
  const TOPE_MB = tipo === "audio" ? 10 : 20;
  if ((media.duration || 0) > TOPE_SEG || (media.file_size || 0) > TOPE_MB * 1024 * 1024) {
    return `\n\n⚠️ ${tipo === "audio" ? "Audio" : "Video"} muy largo o pesado (más de ${TOPE_SEG / 60} min o ${TOPE_MB} MB): no lo proceso automáticamente, abrí el link.`;
  }
  try {
    const url = await bot.telegram.getFileLink(fileId);
    const res = await fetch(url.href);
    if (!res.ok) throw new Error(`No pude descargar (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const texto = await fn(buffer, media.mime_type);
    return texto ? `\n\n${etiqueta}:\n"${texto.slice(0, 1500)}"` : `\n\n(no pude ${tipo === "audio" ? "entender nada en el audio" : "interpretar el video"})`;
  } catch (err) {
    console.error(`Error procesando ${tipo} para el admin:`, err.message);
    return `\n\n⚠️ No pude procesar el ${tipo}: ${err.message}`;
  }
}

// Lista los usuarios que escribieron por privado como botones; al tocar
// uno, muestra el historial de conversación guardado en Firestore.
bot.command("historial", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  try {
    const { usuarios, error } = await listarUsuariosPrivados();
    if (error) return ctx.reply(error);
    if (!usuarios.length) return ctx.reply("Todavía no hay nadie que le haya escrito al bot por privado.");

    const TOPE_USUARIOS = 25;
    const botones = usuarios
      .slice(0, TOPE_USUARIOS)
      .map((u) => [
        Markup.button.callback(`📜 ${u.quien} (${u.cantidad})`, `hist:${u.userId}`),
        Markup.button.callback("💬 Retomar", `retomar:${u.userId}`),
      ]);

    await ctx.reply(
      `Elegí un usuario para ver el historial${usuarios.length > TOPE_USUARIOS ? ` (mostrando los ${TOPE_USUARIOS} más recientes de ${usuarios.length})` : ""}:`,
      Markup.inlineKeyboard(botones)
    );
  } catch (err) {
    console.error("Error listando usuarios para /historial:", err.message);
    await ctx.reply("No pude armar la lista: " + err.message);
  }
});

bot.action(/^hist:(.+)$/, async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return ctx.answerCbQuery();
  const userId = ctx.match[1];
  try {
    await ctx.answerCbQuery("Buscando historial...");
    const { texto } = await getHistorialUsuario(userId);
    // Telegram corta mensajes de más de 4096 caracteres — se manda en
    // pedazos si hace falta, en vez de que falle el envío.
    for (let i = 0; i < texto.length; i += 4000) {
      await ctx.reply(texto.slice(i, i + 4000));
    }
  } catch (err) {
    console.error("Error trayendo historial:", err.message);
    await ctx.reply("No pude traer el historial: " + err.message).catch(() => {});
  }
});

// Retoma la charla con un usuario puntual: redacta un mensaje natural con
// Gemini a partir de su última pregunta guardada, y se lo manda por
// privado en tu nombre (bot).
bot.action(/^retomar:(.+)$/, async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return ctx.answerCbQuery();
  const userId = ctx.match[1];
  try {
    await ctx.answerCbQuery("Retomando conversación...");
    const { ultimaPregunta } = await getUltimaPreguntaUsuario(userId);
    if (!ultimaPregunta) {
      await ctx.reply("No encontré una pregunta previa guardada de ese usuario para retomar.");
      return;
    }
    const mensaje = await generarMensajeRetomar(ultimaPregunta);
    await bot.telegram.sendMessage(userId, mensaje);
    await ctx.reply(`✅ Retomé la charla con ese usuario:\n\n"${mensaje}"`);
  } catch (err) {
    console.error("Error retomando conversación:", err.message);
    const motivo = err.response?.description || err.message;
    await ctx.reply(`No pude retomarla: ${motivo}`).catch(() => {});
  }
});

// Cualquier usuario puede reportar algo (mal estado de un coche, un
// guarda, lo que sea) sin que quede publicado en el grupo. Uso:
// /reporte <mensaje>. Se guarda en Firestore y te llega copia por privado.
// Lista los reportes de /reporte que todavía no marcaste como revisados,
// con un botón para hacerlo desde acá mismo.
bot.command("reportes", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const pendientes = await listarReportesPendientes(10);
  if (!pendientes.length) {
    await ctx.reply("No hay reportes pendientes de revisión 🎉");
    return;
  }

  await ctx.reply(`Hay ${pendientes.length} reporte(s) sin revisar:`);
  for (const r of pendientes) {
    const fecha = new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(r.timestamp));
    await ctx.reply(`👤 ${r.quien} (${r.origen})\n🕐 ${fecha}\n📋 "${r.mensaje}"`, {
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Marcar como revisado", callback_data: `reprev:${r.id}` }]],
      },
    });
  }
});

bot.action(/^reprev:(.+)$/, async (ctx) => {
  if (!esAdminEstado(ctx)) {
    await ctx.answerCbQuery();
    return;
  }
  try {
    await marcarReporteRevisado(ctx.match[1]);
    await ctx.editMessageReplyMarkup();
    await ctx.answerCbQuery("Marcado como revisado ✅");
  } catch (err) {
    console.error("Error marcando reporte revisado:", err.message);
    await ctx.answerCbQuery("Error, mirá los logs");
  }
});

bot.command("reporte", async (ctx) => {
  if (!esChatAutorizado(ctx)) return;

  const texto = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  if (!texto) {
    await ctx.reply("Contame qué querés reportar así: /reporte tu mensaje. Ej: /reporte El coche 3 del tren de las 8 estaba muy sucio.");
    return;
  }

  const esGrupo = ctx.chat?.type !== "private";

  // Intenta borrar el mensaje del grupo para que el reporte no quede
  // expuesto — requiere que el bot sea admin con permiso de borrado; si
  // no lo tiene, sigue igual pero queda visible en el grupo (se avisa).
  let borrado = false;
  if (esGrupo) {
    try {
      await ctx.deleteMessage();
      borrado = true;
    } catch (err) {
      console.error("No pude borrar el mensaje de /reporte:", err.message);
    }
  }

  try {
    const registro = await guardarReporte({ ctx, mensaje: texto });

    if (process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram
        .sendMessage(process.env.ADMIN_TELEGRAM_ID, `📋 Nuevo reporte de ${registro.quien} (${registro.origen}):\n\n"${texto}"`)
        .catch((e) => console.error("Error avisando al admin sobre reporte:", e.message));
    }

    const confirmacion = "✅ Recibimos tu reporte, gracias por ayudarnos a mejorar el servicio.";
    if (esGrupo) {
      // Preferimos confirmar por privado para no repetir el contenido en
      // el grupo. Si el usuario nunca le escribió al bot, Telegram no deja
      // mandarle DM en frío — ahí sí confirmamos en el grupo (sin repetir
      // el texto del reporte, solo un genérico).
      try {
        await bot.telegram.sendMessage(ctx.from.id, confirmacion);
      } catch {
        await ctx
          .reply(`${confirmacion}${borrado ? "" : "\n(no pude borrar tu mensaje del grupo, puede que siga visible)"}`)
          .catch(() => {});
      }
    } else {
      await ctx.reply(confirmacion);
    }
  } catch (err) {
    console.error("Error guardando reporte:", err.message);
    await ctx.reply("Uh, no pude guardar el reporte. Probá de nuevo en un rato, por favor.").catch(() => {});
  }
});

// Si la foto la manda alguien de esColaboradorImagenes() (piloto: por ahora
// vos; después se suman colaboradores por @usuario sin tocar código), la
// trata como un posible comunicado oficial y la analiza con Gemini Vision
// en vez de solo reenviarla. Para cualquier otra persona, sigue
// funcionando como antes (reenvío simple).
// Publica una noticia en el sitio (misma colección Firestore que usa el
// panel de Admin, mismo esquema). Uso: /noticia Título | contenido
// Requiere que "mostrarTitulares" esté activo en el sitio para que se vea
// (eso no lo toca este comando, es un toggle aparte del admin).
// Lista lo guardado en la colección "comunicados" (lectura de imágenes),
// sin filtrar por relevancia, para poder confirmar qué se guardó de
// verdad. Uso: /comunicados [horas] — default 72hs.
bot.command("comunicados", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const horas = parseInt((ctx.message.text || "").split(" ")[1], 10) || 72;
  try {
    const items = await listarComunicados(horas);
    if (items === null) return ctx.reply("Firestore no está configurado (faltan credenciales).");
    if (items.length === 0) return ctx.reply(`No hay ningún comunicado guardado en las últimas ${horas}hs.`);
    const lineas = items.map(
      (d) =>
        `• [${d.esComunicadoRelevante ? "✅ relevante" : "❌ descartado"}] ${d.tipo} — ${d.cargadoPor}\n  Fecha del aviso: ${d.fecha || "no especificada"} | Horario: ${d.horario || "no especificado"}\n  ${d.resumen}\n  (subido ${new Date(d.timestamp).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })})`
    );
    await ctx.reply(`📋 ${items.length} comunicado(s) en las últimas ${horas}hs:\n\n${lineas.join("\n\n")}`);
  } catch (err) {
    console.error("Error en /comunicados:", err.message);
    await ctx.reply("No pude listar los comunicados: " + err.message);
  }
});

// Suma una alerta complementaria al semáforo a mano (mismo campo alertas[]
// que usa el lector de imágenes) — para cuando no hay una imagen para
// subir, o para cargar algo retroactivo. Uso: /alerta <texto>
bot.command("alerta", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const texto = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  if (!texto) {
    await ctx.reply("Uso: /alerta <texto>\n\nEj: /alerta Obra programada (Domingo 27/09): servicio reducido entre Once y Castelar por obras de señalamiento. Horario: desde el primer tren hasta el último.");
    return;
  }
  try {
    const r = await agregarAlertaComplementaria(texto, { push: { titulo: "📢 Aviso de servicio", mensaje: texto, origen: "/alerta" } });
    if (!r.agregado) {
      await ctx.reply(`⚠️ No la sumé: ya hay una alerta activa muy parecida:\n"${r.similar}"\n\nSi igual querés forzarla, primero sacá la vieja con /alertas.`);
    } else {
      await ctx.reply(`✅ Alerta sumada al semáforo del sitio (no cambia el color, es un aviso aparte):\n"${texto}"`);
    }
  } catch (err) {
    console.error("Error en /alerta:", err.message);
    await ctx.reply("No pude sumar la alerta: " + err.message);
  }
});

// Ver / limpiar las alertas complementarias que se muestran en el sitio.
// Uso: /alertas | /alertas quitar <n> | /alertas limpiar
bot.command("alertas", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const args = (ctx.message.text || "").split(" ").slice(1);
  try {
    if (args[0]?.toLowerCase() === "limpiar") {
      await limpiarAlertasComplementarias();
      await ctx.reply("✅ Se vaciaron todas las alertas complementarias del sitio.");
      return;
    }
    if (args[0]?.toLowerCase() === "quitar") {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 1) {
        await ctx.reply("Uso: /alertas quitar <n> (el número que muestra /alertas).");
        return;
      }
      const quitada = await quitarAlertaComplementaria(n - 1);
      await ctx.reply(`🗑️ Saqué del sitio:\n"${quitada}"`);
      return;
    }
    const actuales = await listarAlertasComplementarias();
    if (!actuales.length) {
      await ctx.reply("No hay alertas complementarias activas en el sitio.");
      return;
    }
    await ctx.reply(
      `📋 Alertas complementarias activas (${actuales.length}):\n\n` +
        actuales.map((a, i) => `${i + 1}. ${a}`).join("\n\n") +
        `\n\n/alertas quitar <n> para sacar una · /alertas limpiar para vaciar todo.`
    );
  } catch (err) {
    console.error("Error en /alertas:", err.message);
    await ctx.reply("No pude gestionar las alertas: " + err.message);
  }
});

bot.command("noticia", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const textoCrudo = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const [titulo, ...resto] = textoCrudo.split("|").map((s) => s.trim());
  const contenido = resto.join("|").trim();

  if (!titulo || !contenido) {
    await ctx.reply("Uso: /noticia Título | Contenido de la noticia\n\nEj: /noticia Servicio reducido el domingo 27 | El domingo 27 el Sarmiento circulará con frecuencias reducidas por trabajos de mantenimiento.");
    return;
  }

  try {
    await publicarNoticia({
      titulo,
      contenido,
      creadoPor: `Telegram (${ctx.from?.username ? "@" + ctx.from.username : ctx.from?.id})`,
    });
    await ctx.reply(`✅ Noticia publicada: "${titulo}"\n\n(si no aparece en el sitio, revisá que "mostrarTitulares" esté activo)`);
  } catch (err) {
    console.error("Error publicando noticia:", err.message);
    await ctx.reply("No pude publicar la noticia: " + err.message);
  }
});

// Enciende/apaga las push automáticas (cambios del semáforo y alertas). Uso: /pushauto [on|off]
bot.command("pushauto", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const arg = (ctx.message.text || "").split(" ")[1]?.toLowerCase();
  if (arg === "on" || arg === "off") {
    await setPushAuto(arg === "on", ctx.from?.username || String(ctx.from?.id || ""));
    await ctx.reply(arg === "on" ? "✅ Push automáticas ACTIVADAS." : "⏸ Push automáticas APAGADAS. /push manual sigue andando.");
    return;
  }
  await ctx.reply(
    `📣 Push automáticas: ${pushAutoActivo() ? "ACTIVAS" : "apagadas"}\n\n` +
      "Salen solas cuando: cambia el semáforo (demoras / paro / normalizado), o se suma una alerta (obra programada, cese de servicio, aviso).\n" +
      "El semáforo automático solo avisa si hay cancelaciones.\n\n" +
      "Uso: /pushauto on | /pushauto off"
  );
});

// Muestra cuántos dispositivos recibieron / fallaron en una push. Uso: /pushestado [id]
bot.command("pushestado", async (ctx) => {
  if (!esAdminEstado(ctx)) return;
  const key = process.env.ONESIGNAL_REST_API_KEY;
  const id = (ctx.message.text || "").split(" ")[1]?.trim() || ultimaPushId();
  if (!key) { await ctx.reply("Falta ONESIGNAL_REST_API_KEY en el bot."); return; }
  if (!id) { await ctx.reply("Uso: /pushestado <id> (o mandá una /push primero)."); return; }
  try {
    const keyV2 = key.startsWith("os_v2_");
    const appId = "114f6665-eede-42d0-90ad-4d6480f10c76";
    const r = await fetch(
      keyV2
        ? `https://api.onesignal.com/notifications/${id}?app_id=${appId}`
        : `https://onesignal.com/api/v1/notifications/${id}?app_id=${appId}`,
      { headers: { Authorization: `${keyV2 ? "Key" : "Basic"} ${key}` }, signal: AbortSignal.timeout(30000) }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${JSON.stringify(d.errors || d)}`);
    const cola = d.queued_at ? new Date(d.queued_at * 1000).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "?";
    await ctx.reply(
      `📊 Push ${id}\n` +
        `Entregadas: ${d.successful ?? "?"} · Fallidas: ${d.failed ?? "?"} · Con error: ${d.errored ?? "?"}\n` +
        `Clics: ${d.converted ?? 0} · Pendientes: ${d.remaining ?? 0}\n` +
        `Encolada: ${cola}` +
        (d.platform_delivery_stats ? `\nPor plataforma: ${JSON.stringify(d.platform_delivery_stats)}` : "")
    );
  } catch (err) {
    console.error("Error en /pushestado:", err.message);
    await ctx.reply("No pude consultar el estado: " + err.message);
  }
});

// Manda una notificación push a los suscriptores del sitio (OneSignal), usando
// el mismo proxy que el panel admin: POST {PUSH_PROXY_URL}/notif/enviar.
// Uso: /push Título | Mensaje | url opcional
bot.command("push", async (ctx) => {
  if (!esAdminEstado(ctx)) return;

  const textoCrudo = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const [titulo, mensaje, url] = textoCrudo.split("|").map((s) => s.trim());

  if (!titulo || !mensaje) {
    await ctx.reply("Uso: /push Título | Mensaje | url (opcional)\n\nEj: /push Servicio limitado | Moreno–Liniers por accidente en Flores. Más info en el sitio.");
    return;
  }

  // Camino directo: si trenbot tiene ONESIGNAL_REST_API_KEY, le pega a OneSignal sin pasar
  // por el proxy tren-webs.
  if (process.env.ONESIGNAL_REST_API_KEY) {
    try {
      const data = await enviarPush({ titulo, mensaje, url });
      await ctx.reply(`✅ Push aceptada por OneSignal:\n"${titulo}"\n${mensaje}\n\nID: ${data.id}\nVer entrega: /pushestado`);
    } catch (err) {
      console.error("Error en /push (directo):", err.message);
      await ctx.reply("No pude mandar la push: " + err.message);
    }
    return;
  }

  const base = (process.env.PUSH_PROXY_URL || "https://tren-webs.onrender.com").replace(/\/$/, "");
  const intentar = async () => {
    const r = await fetch(`${base}/notif/enviar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titulo, mensaje, url: url || "https://trensarmientoenlinea.com.ar" }),
      signal: AbortSignal.timeout(45000),
    });
    const texto = await r.text();
    let data = null;
    try { data = JSON.parse(texto); } catch {}
    return { r, data, texto };
  };
  try {
    let res = await intentar();
    // Render (plan free) duerme el servicio: la primera llamada puede dar 502/503/504 mientras despierta.
    if ([429, 502, 503, 504].includes(res.r.status)) {
      const espera = Math.min(Math.max(Number(res.r.headers.get("retry-after")) || 15, 5), 40);
      await ctx.reply(`⏳ El proxy respondió ${res.r.status} (dormido o limitado), reintento en ${espera}s…`);
      await new Promise((ok) => setTimeout(ok, espera * 1000));
      res = await intentar();
    }
    const { r, data, texto } = res;
    if (!r.ok || !data?.ok) {
      const detalle = data ? JSON.stringify(data.error || data) : texto.replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`HTTP ${r.status} — ${detalle}`);
    }
    await ctx.reply(`✅ Push enviada a ${data.recipients ?? "?"} suscriptores:\n"${titulo}"\n${mensaje}`);
  } catch (err) {
    console.error("Error en /push:", err.message);
    await ctx.reply("No pude mandar la push: " + err.message);
  }
});

bot.on("photo", async (ctx) => {
  const esColab = esColaboradorImagenes(ctx);
  let resultadoComunicado;
  if (esColab) {
    resultadoComunicado = await procesarComunicadoDeImagen(ctx);
  } else {
    await reenviarMediaAlAdmin(ctx, "imagen");
  }
  // Capturas de la app de Trenes Argentinos: SOLO las del admin. La imagen de
  // cualquier otro usuario no se lee, no se guarda en Firestore ni genera
  // alertas (30/9: un usuario subió una captura de nuestro propio sitio y el
  // bot la guardó como si fuera de la app). Todo en silencio: solo se le
  // informa al admin.
  if (ctx.chat?.type !== "private" && esChatAutorizado(ctx) && esAdminEstado(ctx) && (!esColab || resultadoComunicado === "no_relevante")) {
    procesarCapturaAppEnCola(ctx).catch((err) => console.error("Error en captura de la app:", err.message));
  }
});

// Captura de la app: Gemini la lee -> se guarda en Firestore con fecha y hora
// del EVENTO -> se hace el barrido de Sarmiento y se coteja contra la captura.
// Se procesan de a una (evita duplicados en paralelo y no satura el proxy).
let colaCapturas = Promise.resolve();
function procesarCapturaAppEnCola(ctx) {
  const tarea = colaCapturas.then(() => procesarCapturaApp(ctx));
  colaCapturas = tarea.catch(() => {});
  return tarea;
}

async function procesarCapturaApp(ctx) {
  const admin = process.env.ADMIN_TELEGRAM_ID;
  const avisar = async (texto, extra) => {
    if (!admin) return;
    for (let i = 0; i < texto.length; i += 3900) {
      const ultimo = i + 3900 >= texto.length;
      await bot.telegram.sendMessage(admin, texto.slice(i, i + 3900), ultimo ? extra : undefined).catch((err) => console.error("Error avisando al admin sobre captura:", err.message));
    }
  };
  const from = ctx.from || {};
  const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
  if (!esAdminEstado(ctx)) return; // doble seguro: capturas de la app solo del admin
  try {
    const foto = ctx.message.photo[ctx.message.photo.length - 1];
    const fileUrl = await bot.telegram.getFileLink(foto.file_id);
    const res = await fetch(fileUrl.href);
    if (!res.ok) throw new Error(`No pude descargar la imagen de Telegram (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const imagenHash = hashImagen(buffer);
    const fileUniqueId = foto.file_unique_id;

    if (await capturaYaProcesada({ imagenHash, fileUniqueId })) {
      console.log(`Captura repetida ignorada — ${quien}`);
      return;
    }

    const datos = await analizarCapturaApp(buffer.toString("base64"));
    recordarCaptura({ imagenHash, fileUniqueId }); // recién ahora: si Gemini falló, se puede reintentar
    if (datos.esSitioPropio) {
      console.log(`Imagen de ${quien}: es una captura de nuestro propio sitio, no se guarda ni se toma como dato`);
      await avisar("ℹ️ La imagen que subiste es una captura de nuestro propio sitio (trensarmientoenlinea.com.ar), no de la app de Trenes Argentinos. Esa información ya la tenemos: no la guardé ni la tomé como dato.");
      return;
    }
    if (!datos.esCapturaAppTrenes) {
      console.log(`Imagen de ${quien}: no es captura de la app de Trenes Argentinos, se ignora`);
      return;
    }

    const subidoEn = new Date((ctx.message.date || Math.floor(Date.now() / 1000)) * 1000);
    const { eventoEn, origen } = calcularEventoEn(datos.horaCaptura, datos.fechaCaptura, subidoEn, datos.horaOrigen);
    const { id } = await guardarCaptura(datos, {
      quien,
      userId: from.id,
      chatId: ctx.chat?.id,
      threadId: ctx.message?.message_thread_id,
      imagenHash,
      fileUniqueId,
      fileId: foto.file_id,
      eventoEn,
      eventoOrigen: origen,
      subidoEn,
    });

    let cotejo = null;
    let errorCotejo = null;
    try {
      cotejo = await cotejarCaptura(datos, eventoEn);
      const { textoBarrido, ...cotejoGuardable } = cotejo;
      await guardarCotejo(id, cotejoGuardable);
    } catch (err) {
      errorCotejo = err.message;
      console.error("Error cotejando captura con el proxy:", err.message);
    }

    // Propuesta de revisión: solo si la captura trae una alerta operativa con
    // un estado claro y quedó guardada (el botón necesita el id del documento).
    let bloque = "";
    let botones;
    const propuesta = id ? proponerEstado(datos) : null;
    if (propuesta) {
      const actual = await getEstadoServicio().catch(() => null);
      const fmtHora = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      bloque += `\n\n👉 Propuesta: semáforo → ${ETIQUETAS_CONFIRMACION[propuesta.estado]}${propuesta.mensaje ? ` — "${propuesta.mensaje}"` : ""}`;
      if (actual) bloque += `\n📊 Ahora en el sitio: ${actual.etiqueta} — "${actual.mensaje}"`;
      const edadMin = Math.round((Date.now() - eventoEn.getTime()) / 60000);
      if (edadMin > 60) bloque += `\n⚠️ La captura tiene ${edadMin} min: el dato puede estar vencido.`;
      if (actual?.actualizado && new Date(actual.actualizado) > eventoEn) bloque += `\n⚠️ El sitio se actualizó (${fmtHora(new Date(actual.actualizado))}) después de esta captura.`;
      if (propuesta.truncado) bloque += "\n⚠️ El texto de la alerta se ve cortado en la captura.";
      botones = Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Tomar dato → ${ETIQUETAS_CONFIRMACION[propuesta.estado]}`, `cap:tomar:${id}`)],
        [Markup.button.callback("🚫 Ignorar", `cap:ignorar:${id}`)],
      ]);
    } else if (!id && (datos.alertas || []).some((a) => a.tipo === "operativa")) {
      bloque += "\n\n(Hay una alerta pero no se pudo guardar la captura, así que no hay botones.)";
    }

    await avisar(
      armarReporte({ datos, quien, chatTitle: ctx.chat?.title, threadId: ctx.message?.message_thread_id, eventoEn, eventoOrigen: origen, subidoEn, cotejo, guardadoId: id }) +
        (errorCotejo ? `\n⚠️ No pude cotejar con el proxy: ${errorCotejo}` : "") +
        bloque,
      botones
    );
  } catch (err) {
    console.error("Error procesando captura de la app:", err.message);
    await avisar(`⚠️ No pude procesar una imagen de ${quien} (¿captura de la app?): ${err.message}`);
  }
}

// Botones del reporte de captura: "Tomar dato" actualiza el semáforo del
// sitio con lo que dice la app; "Ignorar" solo cierra la revisión. Cada
// captura se revisa una sola vez.
bot.action(/^cap:(tomar|ignorar):(.+)$/, async (ctx) => {
  if (!esAdminEstado(ctx)) return ctx.answerCbQuery();
  const [, accion, id] = ctx.match;
  const quien = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id);
  try {
    const r = await revisarCaptura({ id, accion, quien }, { aplicarEstado: actualizarEstadoServicio });
    const quitarBotones = () => ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    if (r.resultado === "no_encontrada") return void (await ctx.answerCbQuery("No encontré esa captura en Firestore.", { show_alert: true }));
    if (r.resultado === "ya_revisada") {
      await ctx.answerCbQuery(`Ya estaba revisada (${r.revision?.accion || "?"}).`);
      return void (await quitarBotones());
    }
    if (r.resultado === "sin_propuesta") return void (await ctx.answerCbQuery("Esta captura no tiene un estado claro para aplicar.", { show_alert: true }));
    await quitarBotones();
    if (r.resultado === "ignorada") {
      await ctx.answerCbQuery("Ignorada.");
      await ctx.reply("🚫 Captura ignorada. El semáforo no se tocó.");
    } else {
      const p = r.propuesta;
      await ctx.answerCbQuery("Semáforo actualizado.");
      await ctx.reply(`✅ Dato tomado. Semáforo: ${ETIQUETAS_CONFIRMACION[p.estado]}${p.mensaje ? ` — "${p.mensaje}"` : ""}`);
    }
  } catch (err) {
    console.error("Error revisando captura:", err.message);
    await ctx.answerCbQuery("No pude aplicarlo, ver mensaje.").catch(() => {});
    await ctx.reply("No pude aplicar la revisión: " + err.message).catch(() => {});
  }
});

// Igual mecánica que cap:, pero para propuestas generadas por el bot mismo
// (cancelaciones/demoras del proxy, avisos de la fuente de verdad) en vez de
// por una imagen. Ver src/propuestasEstado.js.
bot.action(/^est:(tomar|ignorar):(.+)$/, async (ctx) => {
  if (!esAdminEstado(ctx)) return ctx.answerCbQuery();
  const [, accion, id] = ctx.match;
  const quien = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id);
  try {
    const r = await revisarPropuesta({ id, accion, quien }, { aplicarEstado: actualizarEstadoServicio });
    const quitarBotones = () => ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    if (r.resultado === "no_encontrada") return void (await ctx.answerCbQuery("No encontré esa propuesta en Firestore.", { show_alert: true }));
    if (r.resultado === "ya_revisada") {
      await ctx.answerCbQuery(`Ya estaba revisada (${r.revision?.accion || "?"}).`);
      return void (await quitarBotones());
    }
    await quitarBotones();
    if (r.resultado === "ignorada") {
      await ctx.answerCbQuery("Ignorada.");
      await ctx.reply("🚫 Propuesta ignorada. El semáforo no se tocó.");
    } else {
      const p = r.propuesta;
      await ctx.answerCbQuery("Semáforo actualizado.");
      await ctx.reply(`✅ Tomado. Semáforo: ${ETIQUETAS_CONFIRMACION[p.estado]}${p.mensaje ? ` — "${p.mensaje}"` : ""}`);
    }
  } catch (err) {
    console.error("Error revisando propuesta de estado:", err.message);
    await ctx.answerCbQuery("No pude aplicarlo, ver mensaje.").catch(() => {});
    await ctx.reply("No pude aplicar la revisión: " + err.message).catch(() => {});
  }
});

// Las imágenes de comunicados que suben colaboradores EN EL GRUPO se procesan
// en silencio: el bot no publica nada en el grupo (ni confirmaciones ni
// errores), solo le informa al admin por privado. Si la imagen llega por
// privado, sí responde ahí.
// Las imágenes se procesan de a una: si llegan dos iguales juntas (o un
// álbum), la segunda ya encuentra guardada a la primera y se detecta como
// repetida en vez de procesarse en paralelo.
let colaImagenes = Promise.resolve();
function procesarComunicadoDeImagen(ctx) {
  const tarea = colaImagenes.then(() => procesarComunicadoDeImagenSerial(ctx));
  colaImagenes = tarea.catch(() => {});
  return tarea;
}

async function procesarComunicadoDeImagenSerial(ctx) {
  const enGrupo = ctx.chat?.type !== "private";
  const avisarAdmin = (texto) =>
    process.env.ADMIN_TELEGRAM_ID
      ? bot.telegram
          .sendMessage(process.env.ADMIN_TELEGRAM_ID, texto)
          .catch((err) => console.error("Error avisando al admin sobre comunicado:", err.message))
      : Promise.resolve();
  try {
    if (!enGrupo) await ctx.sendChatAction("typing");
    const foto = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = foto.file_id;
    const fileUniqueId = foto.file_unique_id;
    const fileUrl = await bot.telegram.getFileLink(fileId);
    const res = await fetch(fileUrl.href);
    if (!res.ok) throw new Error(`No pude descargar la imagen de Telegram (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");
    const imagenHash = hashImagen(buffer);

    const from = ctx.from || {};
    const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
    const esElAdminPrincipal = String(from.id) === String(process.env.ADMIN_TELEGRAM_ID);

    // Repetido (misma imagen): se corta acá, sin gastar Gemini ni avisar de nuevo.
    if (await esImagenYaProcesada({ imagenHash, fileUniqueId })) {
      console.log(`Comunicado repetido ignorado (misma imagen) — ${quien}`);
      if (!enGrupo) await ctx.reply("Esa imagen ya la había procesado antes, no la cargo de nuevo.");
      return;
    }

    const datos = await analizarComunicadoImagen(base64);

    if (!datos.esComunicadoRelevante) {
      registrarImagenDescartada({ imagenHash, fileUniqueId });
      const textoNoRelevante =
        "No me pareció un comunicado oficial de transporte, así que no lo guardé como fuente de la verdad. Si me equivoco, contame qué decía y lo cargo a mano.";
      if (enGrupo) await avisarAdmin(`🖼️ Imagen de ${quien} en el grupo (${ctx.chat?.title || "sin nombre"}): ${textoNoRelevante}`);
      else await ctx.reply(textoNoRelevante);
      return "no_relevante"; // el llamador puede probar si es una captura de la app
    }

    // Repetido (mismo comunicado en otra imagen/captura): no se guarda, no se
    // suma otra alerta al sitio ni se avisa de nuevo. Igual se registra el
    // hash de esta imagen para cortarla antes en la próxima.
    const duplicado = await buscarComunicadoDuplicado(datos);
    if (duplicado) {
      console.log(`Comunicado repetido ignorado (mismo contenido que uno ya cargado: "${(duplicado.resumen || "").slice(0, 60)}") — ${quien}`);
      await guardarComunicado({ ...datos, esComunicadoRelevante: false, duplicadoDe: duplicado.timestamp }, { quien, userId: from.id, imagenHash, fileUniqueId });
      if (!enGrupo) await ctx.reply("Ese comunicado ya lo tenía cargado, no lo repito.");
      return;
    }

    await guardarComunicado(datos, { quien, userId: from.id, imagenHash, fileUniqueId });

    // Se suma como alerta COMPLEMENTARIA del semáforo (campo alertas[] que
    // ya lee el sitio, independiente del color/mensaje principal) — no
    // como noticia. Best-effort: si falla, no corta el flujo principal
    // (el comunicado ya quedó guardado igual para el bot). Si ya hay una
    // alerta activa parecida (aunque esté redactada distinto), no se
    // duplica — así no se repite el mismo aviso en el sitio cada vez que
    // sube una foto nueva del mismo comunicado.
    let estadoSitio = "agregado";
    try {
      const tituloTipo = { paro: "Paro", demora: "Demoras", normalizacion: "Normalización del servicio", obra: "Obra programada", "aviso general": "Aviso", otro: "Aviso" }[datos.tipo] || "Aviso";
      const textoAlerta = `${tituloTipo}${datos.fecha ? ` (${datos.fecha})` : ""}: ${datos.resumen}${datos.horario ? ` Horario: ${datos.horario}.` : ""}`;
      // Obra, paro, demora o normalización => además sale push automática.
      const mensajePush = `${datos.fecha ? `${datos.fecha}: ` : ""}${datos.resumen}${datos.horario ? ` Horario: ${datos.horario}.` : ""}`;
      const r = await agregarAlertaComplementaria(
        textoAlerta,
        ["obra", "paro", "demora", "normalizacion"].includes(datos.tipo) ? { push: { titulo: `📢 ${tituloTipo}`, mensaje: mensajePush, origen: `comunicado (${datos.tipo})` } } : {}
      );
      estadoSitio = r.agregado ? "agregado" : "ya_habia";
    } catch (err) {
      estadoSitio = "error";
      console.error("Error agregando alerta complementaria del comunicado:", err.message);
    }

    const resumenTexto =
      `📋 Comunicado guardado como fuente de la verdad (subido por ${quien}):\n\n` +
      `Tipo: ${datos.tipo}\n` +
      `Fecha: ${datos.fecha || "no especificada"}\n` +
      `Horario: ${datos.horario || "no especificado"}\n` +
      `Resumen: ${datos.resumen}\n\n` +
      `A partir de ahora el bot puede usar este dato al responder preguntas relacionadas.` +
      (estadoSitio === "agregado"
        ? ` También se sumó como alerta complementaria del semáforo en el sitio (no cambia el color, es un aviso aparte).`
        : estadoSitio === "ya_habia"
          ? ` Ya había una alerta activa parecida en el sitio, no se duplicó.`
          : ` ⚠️ No se pudo sumar la alerta al sitio, revisá los logs.`);

    if (enGrupo) {
      // Grupo: nada público. Solo el admin recibe el resumen, por privado.
      await avisarAdmin(resumenTexto);
    } else {
      await ctx.reply(resumenTexto);
      // Por privado con un colaborador: además se le avisa al admin.
      if (!esElAdminPrincipal) await avisarAdmin(resumenTexto);
    }
  } catch (err) {
    console.error("Error procesando imagen de comunicado:", err.message);
    if (enGrupo) await avisarAdmin(`⚠️ No pude leer una imagen de comunicado subida en el grupo: ${err.message}`);
    else await ctx.reply("No pude leer la imagen: " + err.message).catch(() => {});
  }
}

// Audios: se siguen reenviando al admin como siempre. Además, si el audio lo
// manda una fuente de verdad (Vivi) EN EL GRUPO, el bot lo escucha (lo
// transcribe con Gemini) y lo trata igual que un mensaje de texto suyo: si
// informa accidente/servicio limitado/etc. queda como aviso con vencimiento.
// Todo en silencio: al grupo no se publica nada, solo se le informa al admin.
async function manejarAudio(ctx, tipo) {
  // Si lo va a procesar el flujo de fuente de verdad, ese ya transcribe y
  // muestra el texto — reenviarMediaAlAdmin no repite la transcripción.
  const loToma = ctx.chat?.type !== "private" && esChatAutorizado(ctx) && esFuenteVerdad(ctx);
  await reenviarMediaAlAdmin(ctx, tipo, { transcribir: !loToma });
  if (loToma) await procesarAudioDeFuente(ctx);
}

async function procesarAudioDeFuente(ctx) {
  const admin = process.env.ADMIN_TELEGRAM_ID;
  const avisar = (texto) => (admin ? bot.telegram.sendMessage(admin, texto.slice(0, 4000)).catch((err) => console.error("Error avisando al admin sobre audio:", err.message)) : Promise.resolve());
  const from = ctx.from || {};
  const quien = from.username ? `@${from.username}` : from.first_name || `ID ${from.id}`;
  try {
    const media = ctx.message?.voice || ctx.message?.audio;
    if (!media) return;
    if ((media.duration || 0) > 300 || (media.file_size || 0) > 10 * 1024 * 1024) {
      await avisar(`🎙️ Audio de ${quien} muy largo o pesado (más de 5 min o 10 MB): no lo transcribí.`);
      return;
    }
    const fileUrl = await bot.telegram.getFileLink(media.file_id);
    const res = await fetch(fileUrl.href);
    if (!res.ok) throw new Error(`No pude descargar el audio de Telegram (${res.status})`);
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");

    const texto = await transcribirAudio(base64, media.mime_type || "audio/ogg");
    if (!texto) {
      await avisar(`🎙️ Audio de ${quien}: no pude entender nada (sin voz o muy ruidoso). No cargué ningún aviso.`);
      return;
    }

    const resultado = await procesarMensajeFuente({ texto, quien, userId: from.id, origen: "audio" });
    if (resultado) olvidarTema("estado");
    await sugerirEstadoDesdeAviso(resultado, "aviso_fuente_audio");
    const hora = (iso) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
    const conclusion = !resultado
      ? "→ No lo tomé como aviso del servicio (charla u otro tema). No cargué nada."
      : resultado === "normalizado"
        ? "→ Lo tomé como normalización: cerré los avisos abiertos."
        : `→ Aviso ${resultado.renovado ? "renovado (ya lo tenía)" : "guardado"}: [${resultado.tipo}] ${resultado.resumen}\n   Vigente hasta las ${hora(resultado.venceEn)}${resultado.vigenciaEstimada ? " (estimado)" : ""}.`;
    await avisar(`🎙️ Audio de ${quien} en el grupo, transcripto:\n"${texto.slice(0, 1500)}"\n\n${conclusion}\n\n(/avisos para ver o limpiar)`);
  } catch (err) {
    console.error("Error procesando audio de fuente de verdad:", err.message);
    await avisar(`⚠️ No pude procesar un audio de ${quien}: ${err.message}`);
  }
}

bot.on("voice", (ctx) => manejarAudio(ctx, "audio/nota de voz"));
bot.on("audio", (ctx) => manejarAudio(ctx, "audio"));
bot.on("video", (ctx) => reenviarMediaAlAdmin(ctx, "video"));
bot.on("video_note", (ctx) => reenviarMediaAlAdmin(ctx, "video nota"));

// Moderación de spam/promociones en el grupo: el bot NO responde, intenta
// borrar el mensaje (si es admin del grupo con permiso de borrar) y le avisa
// al admin por privado. No aplica a: el admin, las fuentes de verdad, los
// colaboradores ni los administradores del grupo.
const avisosSpamPorUsuario = new Map(); // userId -> { ultimo: ms, ocultos: n }
async function moderarSpam(ctx, texto) {
  if (esFuenteVerdad(ctx) || esColaboradorImagenes(ctx)) return false;
  const veredicto = await evaluarSpam(texto);
  if (!veredicto.spam) return false;

  // No tocar a los administradores del grupo.
  try {
    const miembro = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (["creator", "administrator"].includes(miembro.status)) return false;
  } catch (err) {
    console.error("Moderación: no pude verificar si es admin del grupo:", err.message);
  }

  let resultadoBorrado;
  try {
    await ctx.deleteMessage();
    resultadoBorrado = "🗑️ Lo borré del grupo.";
  } catch (err) {
    resultadoBorrado = `⚠️ No pude borrarlo (¿el bot es admin del grupo con permiso para borrar mensajes?): ${err.message}`;
  }

  const from = ctx.from || {};
  const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || "sin nombre";
  console.log(`Spam detectado (${veredicto.capa}) de ${quien} [${from.id}]: ${veredicto.motivo}`);

  // Anti-inundación de avisos: un usuario que spamea seguido genera un solo
  // aviso cada 5 minutos, con el conteo de los que se ocultaron.
  const reg = avisosSpamPorUsuario.get(from.id) || { ultimo: 0, ocultos: 0 };
  if (Date.now() - reg.ultimo < 5 * 60 * 1000) {
    avisosSpamPorUsuario.set(from.id, { ...reg, ocultos: reg.ocultos + 1 });
    return true;
  }
  avisosSpamPorUsuario.set(from.id, { ultimo: Date.now(), ocultos: 0 });

  if (process.env.ADMIN_TELEGRAM_ID) {
    const tema = ctx.message?.message_thread_id ? ` (tema ${ctx.message.message_thread_id})` : "";
    await bot.telegram
      .sendMessage(
        process.env.ADMIN_TELEGRAM_ID,
        `🚫 Spam en «${ctx.chat?.title || "grupo"}»${tema}\n👤 ${quien} (ID ${from.id})\n📝 "${texto.slice(0, 400)}"\n🔎 Motivo: ${veredicto.motivo}\n${resultadoBorrado}` +
          (reg.ocultos ? `\n(+${reg.ocultos} mensaje(s) más de este usuario desde el último aviso)` : "")
      )
      .catch((err) => console.error("Error avisando al admin sobre spam:", err.message));
  }
  return true;
}

bot.on("text", async (ctx) => {
  let preguntaParaReintento = null;
  try {
    if (!esChatAutorizado(ctx)) return;

    const textoOriginal = ctx.message.text;
    const esGrupo = ctx.chat?.type !== "private";
    const esChatPrivado = !esGrupo;

    // Spam/promociones en el grupo: no se responde, se borra y se avisa al admin.
    if (esGrupo && (await moderarSpam(ctx, textoOriginal))) return;

    // Alimenta la señal informal de "nadie se queja" — se registra SIEMPRE
    // que sea un mensaje de grupo, aunque no le hablen al bot directamente.
    if (esGrupo) {
      registrarMensajeGrupo(textoOriginal, ctx.from?.id);
      incrementarContadorMensajes();

      // Fuente de verdad (Vivi): lo que escribe sobre el estado del servicio
      // se guarda como aviso con vencimiento y pasa a mandar en el contexto.
      // Se espera acá para que, si en el mismo mensaje también le habla al
      // bot, el aviso ya esté cargado al armar la respuesta.
      if (esFuenteVerdad(ctx)) {
        try {
          const quien = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `ID ${ctx.from?.id}`;
          const resultado = await procesarMensajeFuente({ texto: textoOriginal, quien, userId: ctx.from?.id });
          if (resultado) {
            olvidarTema("estado"); // lo que se contestó antes sobre el estado quedó viejo
            await sugerirEstadoDesdeAviso(resultado, "aviso_fuente_texto");
            console.log(
              resultado === "normalizado"
                ? `Aviso de fuente: normalización, avisos abiertos cerrados (${quien})`
                : `Aviso de fuente ${resultado.renovado ? "renovado (repetido)" : "guardado"}: ${resultado.tipo}, vence ${resultado.venceEn}${resultado.vigenciaEstimada ? " (estimado)" : ""} (${quien})`
            );
          }
        } catch (err) {
          console.error("Error procesando mensaje de fuente de verdad:", err.message);
        }
      }
    }

    // Aviso al admin ante insultos o groserías, en grupo O privado.
    if (esInsulto(textoOriginal) && process.env.ADMIN_TELEGRAM_ID) {
      const from = ctx.from || {};
      const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
      const fechaHora = new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date());
      const origen = esGrupo ? `Grupo: ${ctx.chat?.title || "sin nombre"}` : "Origen: chat privado con el bot";
      bot.telegram
        .sendMessage(
          process.env.ADMIN_TELEGRAM_ID,
          `⚠️ Lenguaje ofensivo detectado (insulto o grosería)\nUsuario: ${quien}\n${origen}\nFecha y hora: ${fechaHora}\nMensaje: "${textoOriginal}"`
        )
        .catch((err) => console.error("Error avisando al admin sobre insulto:", err.message));
    }

    const fueEtiquetado = mencionaAlBot(ctx);

    // Cuánta gente hay ahora en una estación/tren: quien pregunta espera que
    // le conteste alguien que esté ahí. El bot no tiene cámaras y, a pedido del
    // admin (oct 2026), NO contesta estas preguntas: ni al aire ni directo, y
    // tampoco avisa que "no tiene cámaras". Se queda callado.
    if (esOcupacionEnVivo(textoOriginal)) {
      console.log(`Omitida (ocupación en vivo, el bot no responde esto) hilo=${ctx.message.message_thread_id ?? "-"}: "${textoOriginal.slice(0, 80)}"`);
      return;
    }

    // Si hay luz / energía: solo se contesta si alguna fuente viva lo menciona.
    // Sin dato, al aire no responde y, si le preguntan directo, lo dice con
    // honestidad (nunca lo deduce de que el servicio figure como normal).
    if (esConsultaDeLuz(textoOriginal) && !(await hayDatoDeEnergia())) {
      if (esGrupo && !fueEtiquetado) {
        console.log(`Al aire omitida (luz/energía sin dato en las fuentes) hilo=${ctx.message.message_thread_id ?? "-"}: "${textoOriginal.slice(0, 80)}"`);
        return;
      }
      const pregunta = limpiarMencion(textoOriginal) || textoOriginal;
      await ctx.reply(RESPUESTA_SIN_DATO_LUZ, opcionesRespuesta(ctx));
      if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta: RESPUESTA_SIN_DATO_LUZ });
      if (esGrupo) await registrarChatGrupo({ ctx, pregunta, respuesta: RESPUESTA_SIN_DATO_LUZ });
      return;
    }

    // Al aire (sin mención): intenta responder siempre que el tema suene
    // relevante — si no tiene una respuesta concreta, se queda callado
    // (ver manejarSinRespuesta). Si lo mencionan, SIEMPRE responde, y si no
    // sabe, lo dice con honestidad. Es la lógica fija, no un toggle.
    // Si el mensaje es una respuesta (reply) a OTRA PERSONA (no al bot), es
    // casi seguro parte de una charla entre usuarios — el bot no debe meterse
    // ahí aunque las palabras coincidan con el filtro de tema/pregunta.
    const replyMsg = replyReal(ctx);
    const esReplyAOtraPersona = !!replyMsg && replyMsg.from?.username !== botUsername;

    const temaDeLaPregunta = detectarTema(textoOriginal);
    const esConsultaAlAire = esGrupo && !fueEtiquetado && pareceConsultaRelevante(textoOriginal);
    const esRepetida = esConsultaAlAire && !esReplyAOtraPersona && yaRespondidoRecientemente(temaDeLaPregunta); // no repetir el mismo tema en poco tiempo
    const esPreguntaAlAire = esConsultaAlAire && !esReplyAOtraPersona && !esRepetida;

    // Log de diagnóstico: una consulta que parecía relevante y el bot NO tomó.
    if (esConsultaAlAire && !esPreguntaAlAire) {
      console.log(
        `Al aire omitida (${esReplyAOtraPersona ? "es reply a otra persona" : `tema repetido: ${temaDeLaPregunta}`}) hilo=${ctx.message.message_thread_id ?? "-"}: "${textoOriginal.slice(0, 80)}"`
      );
    }

    // "¿Cómo están saliendo los trenes de Once?" → tablero de Once + ancla del
    // tablero en vivo. Al aire respeta lo de siempre: no se mete en charlas
    // entre usuarios (reply a otra persona), no repite el mismo tema en poco
    // tiempo y respeta el límite de uso. Si lo mencionan, siempre contesta.
    if (esConsultaSalidasOnce(textoOriginal) && !esReplyAOtraPersona) {
      if (!fueEtiquetado && esGrupo && yaRespondidoRecientemente("tablero_once")) {
        console.log(`Al aire omitida (tablero de Once ya compartido hace poco) hilo=${ctx.message.message_thread_id ?? "-"}: "${textoOriginal.slice(0, 80)}"`);
        return;
      }
      if (excedioLimite(ctx.from?.id)) {
        if (fueEtiquetado || esChatPrivado) {
          await ctx.reply("Me preguntaste bastante seguido 😅 esperá unos minutos y probá de nuevo.", opcionesRespuesta(ctx));
        }
        return;
      }
      if (await responderConTableroOnce(ctx)) {
        const pregunta = limpiarMencion(textoOriginal) || textoOriginal;
        const resumen = `[Tablero de Once compartido] ${LINK_TABLERO}`;
        if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta: resumen });
        if (esGrupo) await registrarChatGrupo({ ctx, pregunta, respuesta: resumen });
        if (esGrupo && !fueEtiquetado) registrarRespuestaAlAire("tablero_once");
        return;
      }
      // Si no se pudo armar el tablero, sigue el flujo normal (Gemini).
    }

    if (!fueEtiquetado && !esPreguntaAlAire) return;

    const pregunta = limpiarMencion(textoOriginal);
    if (!pregunta) return;
    preguntaParaReintento = pregunta;

    // Límite de uso por persona: protege la cuota gratuita de Gemini.
    if (excedioLimite(ctx.from?.id)) {
      if (fueEtiquetado) {
        await ctx.reply(
          "Me preguntaste bastante seguido 😅 esperá unos minutos y probá de nuevo.",
          opcionesRespuesta(ctx)
        );
      }
      // Si fue una pregunta al aire, directamente no contesta nada.
      else console.log(`Al aire omitida (límite de uso) usuario=${ctx.from?.id}`);
      return;
    }

    const cacheKey = pregunta.toLowerCase().trim();
    const cacheada = cache.get(cacheKey);
    if (cacheada !== undefined) {
      const respuestaCacheada = manejarSinRespuesta(cacheada, fueEtiquetado);
      if (respuestaCacheada) {
        await ctx.reply(respuestaCacheada, opcionesRespuesta(ctx));
        if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta: respuestaCacheada });
        if (esGrupo) await registrarChatGrupo({ ctx, pregunta, respuesta: respuestaCacheada });
        if (esGrupo && !fueEtiquetado) registrarRespuestaAlAire(temaDeLaPregunta);
      }
      return;
    }

    await ctx.sendChatAction("typing");
    const contexto = await armarContexto(pregunta);
    const respuestaCruda = await responderPregunta({ pregunta, contexto });

    cache.set(cacheKey, respuestaCruda);
    const respuesta = manejarSinRespuesta(respuestaCruda, fueEtiquetado);
    if (respuesta) {
      await ctx.reply(respuesta, opcionesRespuesta(ctx));
      if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta });
      if (esGrupo) await registrarChatGrupo({ ctx, pregunta, respuesta });
      if (esGrupo && !fueEtiquetado) registrarRespuestaAlAire(temaDeLaPregunta);
    }
    if (!respuesta && !fueEtiquetado) console.log(`Al aire omitida (Gemini sin respuesta concreta): "${pregunta.slice(0, 80)}"`);
    // Si respuesta es null (pregunta al aire sin dato concreto), el bot se
    // queda callado a propósito — no hace falta contestar cada cosa que se
    // dice en el grupo si no tiene algo útil que aportar.
  } catch (err) {
    console.error("Error respondiendo mensaje:", err);
    if (ctx.chat?.type === "private") {
      await registrarChatPrivado({
        ctx,
        pregunta: ctx.message?.text ?? null,
        respuesta: null,
        error: err.message,
      });
    } else {
      await registrarChatGrupo({
        ctx,
        pregunta: ctx.message?.text ?? null,
        respuesta: null,
        error: err.message,
      });
    }
    // Si el error fue por falta de permiso para escribir (Tema restringido,
    // bot sin rango, etc.), reintentar el aviso de error es inútil — va a
    // fallar exactamente igual. Evita un loop de errores en el log.
    if (/not enough rights|CHAT_WRITE_FORBIDDEN/i.test(err.message || "")) return;
    await ctx.reply(RESPUESTA_ERROR_TECNICO, ctx.message ? opcionesRespuesta(ctx) : undefined).catch(() => {});

    // Si fue un error TRANSITORIO (Gemini saturado/cuota) y llegamos a tener
    // una pregunta armada, la encolamos para reintentar sola en el próximo
    // ping periódico, y avisamos al admin ahora mismo con el contenido del
    // mensaje — así no depende de mirar el log de Render (que rota) para
    // enterarse de qué se perdió.
    if (esErrorTransitorio(err) && preguntaParaReintento && process.env.ADMIN_TELEGRAM_ID) {
      const from = ctx.from || {};
      const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
      encolarReintento({
        tipo: ctx.chat?.type === "private" ? "privado" : "grupo",
        chatId: ctx.chat?.id,
        threadId: ctx.message?.message_thread_id ?? null,
        userId: from.id,
        pregunta: preguntaParaReintento,
        quien,
      });
      bot.telegram
        .sendMessage(
          process.env.ADMIN_TELEGRAM_ID,
          `⚠️ No pude responder por error técnico (${ctx.chat?.type === "private" ? "privado" : "grupo"}), lo voy a reintentar solo:\nDe: ${quien}\nMensaje: "${preguntaParaReintento}"\nError: ${err.message}`
        )
        .catch((e) => console.error("Error avisando al admin sobre fallo:", e.message));
    }
  }
});

// --- Webhook + healthcheck ---
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.get("/", (_req, res) => res.send("Bot Tren Sarmiento activo."));

// Reintenta las preguntas encoladas por error transitorio. Si esta vez
// Gemini responde, se la manda a quien preguntó (tarde, pero llega) y se
// registra como resuelta; si se agotan los intentos o pasó demasiado
// tiempo, se descarta sola (ver retryQueue.js) sin generar más ruido.
async function procesarColaReintentos() {
  const pendientes = listaPendientes();
  let resueltos = 0;
  for (const item of pendientes) {
    marcarIntento(item);
    try {
      const contexto = await armarContexto(item.pregunta);
      const respuestaCruda = await responderPregunta({ pregunta: item.pregunta, contexto });
      const respuesta = manejarSinRespuesta(respuestaCruda, true);
      if (respuesta) {
        const prefijo = `(Perdón la demora, tuve un problema técnico antes) `;
        await bot.telegram.sendMessage(item.chatId, prefijo + respuesta, item.threadId ? { message_thread_id: item.threadId } : undefined);
      }
      const ctxFalso = { chat: { id: item.chatId, title: null, type: item.tipo === "privado" ? "private" : "group" }, from: { id: item.userId }, message: { message_thread_id: item.threadId } };
      if (item.tipo === "grupo") {
        await registrarChatGrupo({ ctx: ctxFalso, pregunta: item.pregunta, respuesta });
      } else {
        await registrarChatPrivado({ ctx: ctxFalso, pregunta: item.pregunta, respuesta });
      }
      quitarDeCola(item);
      resueltos++;
    } catch (err) {
      // Sigue en la cola (marcarIntento ya sumó el intento); si esErrorTransitorio
      // sigue fallando, se reintenta en el próximo ping hasta agotar MAX_INTENTOS.
      console.error("Reintento fallido para:", item.pregunta, "-", err.message);
    }
  }
  return { resueltos, pendientes: listaPendientes().length };
}

// Disparado por un ping externo (cron-job.org, ver README) cada 10-15 min.
// Protegido por CHECK_SECRET (o CRON_SECRET, para el cron nativo de Render)
// para que nadie más lo pueda gatillar.
app.get("/internal/check", async (req, res) => {
  const secretValido =
    (process.env.CHECK_SECRET && req.query.secret === process.env.CHECK_SECRET) ||
    (process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET);
  console.log(`/internal/check llamado (secret ${secretValido ? "OK" : "INVÁLIDO o ausente"})`); // visibilidad: para confirmar que el ping externo llega
  if (!secretValido) {
    return res.status(403).send("forbidden");
  }
  try {
    await chequeoPeriodicoProxy("cron");
    const resultado = await chequearYNotificar(bot);
    const informeDiario = await chequearYEnviarInformeDiario(bot);
    const reintentos = await procesarColaReintentos();
    res.json({ ...resultado, informeDiario, reintentos });
  } catch (err) {
    console.error("Error en /internal/check:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tablero en tiempo real (HTML + API propia). Vive ACÁ, en el bot, y no como
// artifact publicado: una página publicada no puede hacer fetch a dominios
// externos (ni siquiera a este mismo Render), así que la única forma de que
// se autoactualice de verdad con datos reales es que la sirva este servidor,
// que ya es el que consulta el proxy. La API interna reusa barridoEstructurado
// (con su caché de 2 min) para no golpear el proxy en cada refresco del navegador.
function claveTableroValida(req) {
  // OJO: nunca cae en CHECK_SECRET -- esa es la clave del cron interno, no
  // pensada para exponerla en una URL pública. Si TABLERO_KEY no está
  // configurada, el tablero queda abierto (para embeberlo en el sitio).
  const clave = process.env.TABLERO_KEY;
  return !clave || req.query.key === clave;
}

app.get("/tablero-vivo", (req, res) => {
  if (!claveTableroValida(req)) {
    console.log("/tablero-vivo: 403 (clave inválida o ausente)");
    return res.status(403).send("forbidden");
  }
  res.set("Content-Type", "text/html; charset=utf-8").send(tableroVivoHTML());
});

// Estilo cartelera física (como la de Once): columnas de próximas salidas de
// una cabecera + el listado fijo de estaciones del ramal, para el "banner"
// de abajo de cada columna. Se cachea 20s (varias visitas casi juntas no
// deberían disparar 5 consultas nuevas al proxy cada vez).
let cacheCabecera = new Map(); // estacion -> { momento, data }
app.get("/mapa-vivo", (req, res) => {
  if (!claveTableroValida(req)) {
    console.log("/mapa-vivo: 403 (clave inválida o ausente)");
    return res.status(403).send("forbidden");
  }
  res.set("Content-Type", "text/html; charset=utf-8").send(mapaVivoHTML());
});

app.get("/api/tablero-mapa", async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGENES_TABLERO_PERMITIDOS.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  if (!claveTableroValida(req)) {
    console.log("/api/tablero-mapa: 403 (clave inválida o ausente)");
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const barrido = await barridoEstructurado();
    const trenes = posicionesEnVivo(barrido.todos, new Date());
    res.json({ estaciones: ESTACIONES_BARRIDO, trenes, horaActual: hora(new Date().toISOString()), consultadoEn: new Date().toISOString(), erroresProxy: barrido.errores });
  } catch (err) {
    console.error("Error en /api/tablero-mapa:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/tablero-cabecera", async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGENES_TABLERO_PERMITIDOS.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  if (!claveTableroValida(req)) {
    console.log("/api/tablero-cabecera: 403 (clave inválida o ausente)");
    return res.status(403).json({ error: "forbidden" });
  }
  const estacion = (req.query.estacion || "Once").toString();
  try {
    const cacheado = cacheCabecera.get(estacion);
    let data;
    if (cacheado && Date.now() - cacheado.momento < 20000) {
      data = cacheado.data;
    } else {
      data = await columnasCabecera(estacion);
      cacheCabecera.set(estacion, { momento: Date.now(), data });
    }
    registrarSnapshot().catch(() => {}); // alimenta /tablero <min> (respeta el mínimo de 2 min entre fotos)
    res.json({ ...data, horaActual: hora(new Date().toISOString()), estaciones: ESTACIONES_BARRIDO, consultadoEn: new Date().toISOString() });
  } catch (err) {
    console.error("Error en /api/tablero-cabecera:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// CORS: el sitio (trensarmientoenlinea.com.ar) llama a esta API desde el
// navegador del visitante para pintar el tablero en vivo embebido. Solo se
// habilita para ese dominio, igual que hace el proxy de OneSignal del sitio.
const ORIGENES_TABLERO_PERMITIDOS = new Set(["https://trensarmientoenlinea.com.ar", "https://www.trensarmientoenlinea.com.ar"]);
app.get("/api/tablero-vivo", async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGENES_TABLERO_PERMITIDOS.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  if (!claveTableroValida(req)) {
    console.log("/api/tablero-vivo: 403 (clave inválida o ausente)");
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const barrido = await barridoEstructurado();
    const inusuales = new Set(trenesConOrigenInusual(barrido.todos).map((i) => datosServicio(i).s.numero));

    // Un mismo tren aparece una vez por cada estación que le queda por
    // delante; para el tablero interesa una fila por tren, con la próxima
    // estación (prog más chico) como referencia.
    const porTren = new Map();
    for (const item of barrido.todos) {
      const d = datosServicio(item);
      const num = d.s.numero ?? `s-${Math.random()}`;
      const actual = porTren.get(num);
      if (!actual || (d.prog || "") < (actual.d.prog || "")) porTren.set(num, { item, d });
    }
    const servicios = [...porTren.values()]
      .sort((a, b) => (a.d.prog || "").localeCompare(b.d.prog || ""))
      .map(({ d }) => ({
        numero: d.s.numero ?? null,
        proximaEstacion: d.est.nombre,
        destino: d.destino,
        origen: d.origenReal,
        origenInusual: inusuales.has(d.s.numero),
        prog: d.prog,
        estim: d.estim,
        demoraMin: d.demora,
        estado: d.estado,
        anden: d.anden,
        cancelado: !!d.s.cancelacion,
        motivoCancelacion: d.s.cancelacion ? textoCancelacion(d.s.cancelacion) : null,
      }));

    res.json({ consultadoEn: new Date().toISOString(), servicios, servicioLimitado: resumenTramo(await getTramoLimitado().catch(() => null)), erroresProxy: barrido.errores });
  } catch (err) {
    console.error("Error en /api/tablero-vivo:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Registro de la "Validación de Usuario" del mapa del sitio. El navegador manda solo datos derivados
// (sin coordenadas) como text/plain para evitar el preflight de CORS; se guarda en Firestore.
app.options("/api/validacion-gps", (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGENES_TABLERO_PERMITIDOS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  res.sendStatus(204);
});
app.post("/api/validacion-gps", express.text({ type: "*/*", limit: "4kb" }), async (req, res) => {
  const origin = req.headers.origin;
  if (!origin || !ORIGENES_TABLERO_PERMITIDOS.has(origin)) return res.status(403).json({ error: "forbidden" });
  res.setHeader("Access-Control-Allow-Origin", origin);
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim();
  if (excedioLimiteValidaciones(ip)) return res.status(429).json({ error: "demasiados envíos" });
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    const r = await registrarValidacion(body);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) {
    console.error("Error en /api/validacion-gps:", err.message);
    res.status(400).json({ ok: false, error: "payload inválido" });
  }
});

const PORT = process.env.PORT || 3000;
// Chequeo periódico compartido por el cron externo y el timer interno: avisa
// cancelaciones nuevas siempre; si /apptrenes auto está activo (incidente en
// curso), además manda el barrido COMPLETO de las 16 estaciones.
// Le propone al admin, por privado, un cambio de semáforo a partir de una
// detección automática (cancelación/demora del proxy, o aviso de la fuente
// de verdad por texto/audio). El bot NUNCA escribe el semáforo solo desde
// acá: solo si el admin toca "✅ Tomar". detalle es el texto que ve el admin
// arriba de la propuesta, para saber de qué se trata.
async function sugerirEstado({ origen, detalle, alerta }) {
  if (!process.env.ADMIN_TELEGRAM_ID) return;
  try {
    const r = await crearPropuesta({ origen, detalle, alerta });
    if (!r) return; // alerta sin severidad reconocida (ej. informativa) -> no hay nada para proponer
    const { id, propuesta } = r;
    // Con el semáforo automático activo, las demoras/cancelaciones del proxy que
    // solo llevarían a "con demoras" ya las cubre estadoAuto.js: no se repite
    // la propuesta con botones. Paro y avisos de la fuente siguen igual.
    if (estadoAutoActivo() && (origen === "proxy_cancelacion" || origen === "proxy_demora") && propuesta.estado === "modificado") return;
    let texto = `🚦 Propuesta de semáforo (${origen})\n${detalle}\n\n👉 Semáforo → ${ETIQUETAS_CONFIRMACION[propuesta.estado]}${propuesta.mensaje ? ` — "${propuesta.mensaje}"` : ""}`;
    const actual = await getEstadoServicio().catch(() => null);
    if (actual) texto += `\n📊 Ahora en el sitio: ${actual.etiqueta} — "${actual.mensaje}"`;
    const botones = id
      ? Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Tomar → ${ETIQUETAS_CONFIRMACION[propuesta.estado]}`, `est:tomar:${id}`)],
          [Markup.button.callback("🚫 Ignorar", `est:ignorar:${id}`)],
        ])
      : undefined;
    await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto, botones);
  } catch (err) {
    console.error(`Error sugiriendo estado (${origen}):`, err.message);
  }
}

// Traduce un resultado de procesarMensajeFuente (texto o audio de la fuente
// de verdad) en una propuesta de semáforo. "otro_relevante" no tiene
// severidad operativa clara, así que no genera propuesta (queda solo como
// contexto para responder preguntas). Un aviso RENOVADO (ya avisado antes)
// tampoco vuelve a proponer, para no repetir el mismo cartel cada vez que se
// reconfirma lo mismo.
async function sugerirEstadoDesdeAviso(resultado, origen) {
  if (!resultado) return;
  if (resultado === "normalizado") {
    await sugerirEstado({ origen, detalle: "La fuente de verdad informó que el servicio se normalizó.", alerta: { estado: "normalizado", texto: "Servicio normalizado." } });
    return;
  }
  if (resultado.renovado) return;
  const MAPA_TIPO_A_ESTADO = { accidente: "cancelado", servicio_limitado: "demorado", demora: "demorado", interrumpido: "interrumpido" };
  const estado = MAPA_TIPO_A_ESTADO[resultado.tipo];
  if (!estado) return;
  await sugerirEstado({
    origen,
    detalle: `Aviso de fuente de verdad [${resultado.tipo}]: ${resultado.resumen}`,
    alerta: { estado, texto: resultado.resumen, lugar: null },
  });
}

async function chequeoPeriodicoProxy(origen) {
  const TEMA_ALERTAS = Number(process.env.TEMA_ALERTAS_ID || 33551);
  const publicarEnGrupo = async (texto) => {
    const grupoId = process.env.ALLOWED_GROUP_ID;
    if (!grupoId) {
      console.error("No pude publicar en el grupo: falta ALLOWED_GROUP_ID.");
      return;
    }
    await bot.telegram.sendMessage(grupoId, texto, { message_thread_id: TEMA_ALERTAS }).catch((err) => console.error(`Error publicando en el grupo (tema ${TEMA_ALERTAS}):`, err.message));
  };

  try {
    const cancelProxy = await chequearCancelacionesProxy();
    console.log(
      cancelProxy.desactivado
        ? `Chequeo proxy (${origen}): monitoreo desactivado (APP_TRENES_MONITOR_ACTIVO=false)`
        : cancelProxy.error
          ? `Chequeo proxy (${origen}): error consultando el proxy — ${cancelProxy.error}`
          : `Chequeo proxy (${origen}): ${cancelProxy.nuevas.length} cancelación(es) nueva(s)${escaneoCompletoActivo() ? " · escaneo completo activo" : ""}`
    );
    if (cancelProxy.texto && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, cancelProxy.texto).catch((err) => console.error("Error avisando cancelaciones del proxy:", err.message));
    }
    for (const t of cancelProxy.textosGrupo || []) await publicarEnGrupo(t);
    for (const item of cancelProxy.nuevas || []) {
      const d = datosServicio(item);
      await sugerirEstado({
        origen: "proxy_cancelacion",
        detalle: `Tren cancelado, destino ${d.destino}, programado ${hora(d.prog)} (${d.est.nombre}).`,
        alerta: { estado: "cancelado", texto: `Tren cancelado con destino ${d.destino} (${hora(d.prog)}).`, lugar: d.est.nombre },
      });
    }
  } catch (err) {
    console.error(`Error chequeando cancelaciones del proxy (${origen}):`, err.message);
  }

  try {
    const demorasProxy = await chequearDemorasProxy();
    if (!demorasProxy.desactivado) console.log(`Chequeo proxy (${origen}): ${demorasProxy.nuevos?.length ?? 0} tren(es) con demora nueva de 10+ min`);
    if (demorasProxy.texto && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, demorasProxy.texto).catch((err) => console.error("Error avisando demoras del proxy:", err.message));
    }
    for (const t of demorasProxy.textosGrupo || []) await publicarEnGrupo(t);
    for (const item of demorasProxy.nuevos || []) {
      const d = datosServicio(item);
      await sugerirEstado({
        origen: "proxy_demora",
        detalle: `Tren demorado ~${d.demora} min, destino ${d.destino}, programado ${hora(d.prog)} (${d.est.nombre}).`,
        alerta: { estado: "demorado", texto: `Demoras de ~${d.demora} min con destino ${d.destino}.`, lugar: d.est.nombre },
      });
    }
  } catch (err) {
    console.error(`Error chequeando demoras del proxy (${origen}):`, err.message);
  }

  try {
    const tramoProxy = await chequearTramoLimitadoProxy();
    if (tramoProxy.texto && process.env.ADMIN_TELEGRAM_ID) {
      olvidarTema("estado");
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, tramoProxy.texto).catch((err) => console.error("Error avisando servicio limitado del proxy:", err.message));
    }
  } catch (err) {
    console.error(`Error chequeando servicio limitado (${origen}):`, err.message);
  }

  try {
    await registrarSnapshot(); // foto del tablero para /tablero <minutos>
  } catch (err) {
    console.error(`Error guardando foto del tablero (${origen}):`, err.message);
  }

  try {
    const origenesProxy = await chequearOrigenesInusuales();
    if (!origenesProxy.desactivado) console.log(`Chequeo proxy (${origen}): ${origenesProxy.nuevos?.length ?? 0} tren(es) con origen inusual nuevo(s)`);
    if (origenesProxy.texto && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, origenesProxy.texto).catch((err) => console.error("Error avisando origen inusual:", err.message));
    }
  } catch (err) {
    console.error(`Error chequeando orígenes inusuales (${origen}):`, err.message);
  }

  try {
    const localesProxy = await chequearLocalesFueraCronograma();
    if (!localesProxy.desactivado) console.log(`Chequeo proxy (${origen}): ${localesProxy.nuevos?.length ?? 0} local(es) fuera de cronograma nuevo(s)`);
    if (localesProxy.texto && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, localesProxy.texto).catch((err) => console.error("Error avisando locales fuera de cronograma:", err.message));
    }
    for (const t of localesProxy.textosGrupo || []) await publicarEnGrupo(t);
  } catch (err) {
    console.error(`Error chequeando locales fuera de cronograma (${origen}):`, err.message);
  }

  try {
    const auto = await evaluarEstadoAutomatico();
    console.log(`Chequeo proxy (${origen}): semáforo automático → ${auto.accion}`);
    if (auto.texto && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, auto.texto).catch((err) => console.error("Error avisando cambio de semáforo automático:", err.message));
    }
  } catch (err) {
    console.error(`Error en el semáforo automático (${origen}):`, err.message);
  }

  if (escaneoCompletoActivo() && process.env.ADMIN_TELEGRAM_ID) {
    try {
      const texto = `⏱️ Escaneo automático completo (${origen})\n\n` + (await barridoSarmiento({ completo: true }));
      for (let i = 0; i < texto.length; i += 3900) {
        await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, texto.slice(i, i + 3900)).catch((err) => console.error("Error mandando escaneo completo automático:", err.message));
      }
    } catch (err) {
      console.error("Error en escaneo automático completo:", err.message);
    }
  }
}

app.listen(PORT, async () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  await cargarSilencio(); // restaura el modo silencio si estaba activo antes de un reinicio
  await cargarEscaneoCompleto(); // restaura /apptrenes auto si estaba activo antes de un reinicio
  await cargarEstadoAuto(); // restaura /estadoauto y la última anomalía vista
  await cargarPushAuto(); // restaura /pushauto y el anti-spam de las push automáticas
  iniciarVigiaSalidas(); // vigila Once y Moreno cada 30 s: en estación / salió / en camino
  iniciarViajes({ enviar: (chatId, texto) => bot.telegram.sendMessage(chatId, texto) }); // asistente de viaje: retoma viajes en curso
  iniciarPushAuto({ notificarAdmin: (t) => (process.env.ADMIN_TELEGRAM_ID ? bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, t).catch((e) => console.error("Error avisando push al admin:", e.message)) : null) });
  alCambiarEstado((e) => pushPorCambioEstado(e));
  alAgregarAlerta((a) => pushPorAlerta(a));

  // Respaldo interno: mientras el servicio esté despierto (Render free se
  // duerme sin tráfico), chequea cancelaciones del proxy cada 5 min sin
  // depender solo del ping externo de cron-job.org — así, si hay actividad
  // en el chat que lo mantiene despierto, el chequeo no espera al ping.
  let chequeoProxyEnCurso = false;
  setInterval(async () => {
    if (chequeoProxyEnCurso) return;
    chequeoProxyEnCurso = true;
    try {
      await chequeoPeriodicoProxy("timer interno");
    } finally {
      chequeoProxyEnCurso = false;
    }
  }, 5 * 60 * 1000);
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    await bot.telegram.setWebhook(`${publicUrl}${WEBHOOK_PATH}`);
    console.log("Webhook configurado en:", `${publicUrl}${WEBHOOK_PATH}`);
  } else {
    console.warn(
      "PUBLIC_URL no configurada: seteá el webhook manualmente una vez desplegado."
    );
  }
});
