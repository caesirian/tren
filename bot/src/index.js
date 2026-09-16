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
import { getEstadoServicio, actualizarEstadoServicio } from "./firestoreStatus.js";
import { getAlertasTrenes } from "./apiTransporte.js";
import { responderPregunta, SIN_RESPUESTA_SENTINEL, esErrorTransitorio, generarMensajeRetomar } from "./gemini.js";
import { detectarEstaciones, proximosTrenesEnEstacion, ultimosTrenes, horaArgentinaTexto, proximosLocales, proximosLocalesTodasEstaciones, proximoDiferencial, DIFERENCIAL, horariosLocalesEstacion, getDayType, infoTransporteEstacion } from "./schedule.js";
import { registrarMensajeGrupo, getSenalComunidad } from "./complaintTracker.js";
import { registrarChatPrivado } from "./privateChatLogger.js";
import { registrarChatGrupo } from "./groupChatLogger.js";
import { guardarReporte } from "./reportLogger.js";
import { consultarParoEnVivo } from "./paroSearch.js";
import { chequearYNotificar } from "./monitor.js";
import { chequearYEnviarInformeDiario, generarInformeTexto, listarFallidosRecientes, reintentarFallidosGuardados, listarUsuariosPrivados, getHistorialUsuario, getUltimaPreguntaUsuario } from "./dailyReport.js";
import { encolarReintento, listaPendientes, marcarIntento, quitarDeCola } from "./retryQueue.js";
import { chequearYActualizarDesdeX } from "./xMonitor.js";
import { esInsulto } from "./insultDetector.js";
import { excedioLimite } from "./rateLimiter.js";
import { analizarComunicadoImagen, guardarComunicado, comunicadosRecientes } from "./imageIntel.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN en las variables de entorno.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
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

function mencionaAlBot(ctx) {
  const text = ctx.message?.text ?? "";
  const esRespuestaAlBot =
    ctx.message?.reply_to_message?.from?.username === botUsername;
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
];

// Palabras/signos que indican que es una pregunta.
const PISTAS_PREGUNTA = [
  "?", "¿", "cuándo", "cuando", "cuánto", "cuanto", "dónde", "donde", "cómo",
  "como", "hay", "sabe", "alguien sabe", "a qué hora", "a que hora",
  "qué hora", "que hora",
];

function pareceConsultaRelevante(text) {
  const lower = text.toLowerCase();
  const tieneTema = PALABRAS_TEMA.some((p) => lower.includes(p));
  const tienePregunta = PISTAS_PREGUNTA.some((p) => lower.includes(p));
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
function manejarSinRespuesta(respuestaCruda, fueEtiquetado) {
  const esSinRespuesta = respuestaCruda.trim() === SIN_RESPUESTA_SENTINEL;
  if (!esSinRespuesta) return respuestaCruda;
  return fueEtiquetado ? RESPUESTA_SIN_DATO : null;
}

async function armarContexto(pregunta) {
  const partes = [TREN_SARMIENTO_INFO];

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

  // Si preguntan por el Diferencial, calculamos la próxima salida real.
  if (/diferencial|preferencial/i.test(pregunta)) {
    const ahora = new Date();
    const dif = proximoDiferencial(ahora);
    let texto = `\n== SERVICIO DIFERENCIAL (calculado ahora, hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==\nCircula ${DIFERENCIAL.dias}, una sola vuelta por día, parando solo en ${DIFERENCIAL.paradas.join(", ")}. Precio: $${DIFERENCIAL.precio} (tarifa única, sin descuento social).\nHorario Once→Moreno: sale Once ${DIFERENCIAL.haciaMoreno.Once}, Haedo ${DIFERENCIAL.haciaMoreno.Haedo_llega}/${DIFERENCIAL.haciaMoreno.Haedo_sale}, llega Moreno ${DIFERENCIAL.haciaMoreno.Moreno}.\nHorario Moreno→Once: sale Moreno ${DIFERENCIAL.haciaOnce.Moreno}, Haedo ${DIFERENCIAL.haciaOnce.Haedo_llega}/${DIFERENCIAL.haciaOnce.Haedo_sale}, llega Once ${DIFERENCIAL.haciaOnce.Once}.\n`;
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
      const proximos = proximosTrenesEnEstacion({ estacionId: estacion.id, ahora });
      const ultimos = ultimosTrenes(ahora);
      const transporte = infoTransporteEstacion(estacion.name);
      partes.push(`
== TRANSPORTE EN LA ZONA DE "${estacion.name}" ==
${transporte || "Sin datos de colectivos/subte cargados para esta estación."}`);
      partes.push(`
== HORARIOS REALES CALCULADOS AHORA PARA "${estacion.name}" (cronograma oficial, hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==
Próximos trenes hacia Moreno desde ${estacion.name}: ${proximos.haciaMoreno.map((t) => `${t.hora} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy"}
Próximos trenes hacia Once desde ${estacion.name}: ${proximos.haciaOnce.map((t) => `${t.hora} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy"}
Último tren de hoy (${ultimos.diaTipo === "lv" ? "día hábil" : ultimos.diaTipo === "sab" ? "sábado" : "domingo/feriado"}) saliendo de Once: ${ultimos.desdeOnce.ultimo} (penúltimo: ${ultimos.desdeOnce.penultimo})
Último tren de hoy saliendo de Moreno: ${ultimos.desdeMoreno.ultimo} (penúltimo: ${ultimos.desdeMoreno.penultimo})
Estos horarios están calculados en el momento con el cronograma base oficial vigente y son la fuente más precisa disponible — no derives a la app si esta sección ya responde la pregunta.`);

      const locales = proximosLocales(estacion.name, ahora);
      const todosLosHorarios = horariosLocalesEstacion(estacion.name);
      let bloqueLocales;
      if (!todosLosHorarios.length) {
        bloqueLocales = `Esta estación NO tiene servicios "locales" designados en ningún horario del día (los locales solo existen en Flores, Liniers, Merlo y Castelar). Puede tomar cualquier tren regular con los horarios de arriba.`;
      } else if (getDayType(ahora) !== "lv") {
        bloqueLocales = `Hoy no circula ningún local porque los locales solo son de lunes a viernes. En días hábiles, los horarios habituales en esta estación son: ${todosLosHorarios.map((l) => `${l.hora} ${l.direccion}`).join(", ")}.`;
      } else if (!locales.length) {
        bloqueLocales = `Ya pasaron todos los locales programados de HOY en esta estación (eran a las ${todosLosHorarios.map((l) => `${l.hora} ${l.direccion}`).join(", ")}) — no es que el servicio dejó de funcionar, simplemente ya no quedan más locales por salir hoy. Puede tomar cualquier tren regular con los horarios de arriba, o volver a preguntar mañana por los mismos horarios.`;
      } else {
        bloqueLocales = locales.map((l) => `${l.hora} ${l.direccion} (en ${l.enMinutos} min)`).join(", ");
      }
      partes.push(`
== "LOCALES" (formaciones que arrancan VACÍAS) EN "${estacion.name}" ==
IMPORTANTE: un "local" NO es cualquier tren que pasa por la estación — es una formación puntual que arranca vacía ahí mismo, muy buscada porque conviene subirse antes de que se llene.
${bloqueLocales}`);
    }
  } else if (/\blocal(es)?\b/i.test(pregunta)) {
    // Preguntan por "locales" sin decir de qué estación — les paso el listado completo de hoy.
    const ahora = new Date();
    const todos = proximosLocalesTodasEstaciones(ahora);
    const estaciones = Object.keys(todos);
    partes.push(`
== TODOS LOS "LOCALES" DE HOY (calculado ahora, hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==
IMPORTANTE: un "local" es una formación que arranca VACÍA en esa estación puntual (no cualquier tren de paso). Solo hay locales designados en Flores, Liniers, Merlo y Castelar, y solo en días hábiles.
${
  estaciones.length
    ? estaciones.map((est) => `${est}: ${todos[est].map((l) => `${l.hora} ${l.direccion} (en ${l.enMinutos} min)`).join(", ")}`).join("\n")
    : "No quedan más locales programados por hoy (o no es día hábil)."
}
Esta es la lista completa y precisa — no derives a la app, esto ya responde la pregunta.`);
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
function esAdminEstado(ctx) {
  const lista = (process.env.ESTADO_ADMIN_IDS || process.env.ADMIN_TELEGRAM_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return lista.includes(String(ctx.from?.id));
}

// Lista APARTE (no mezclar con esAdminEstado, que da permiso de cambiar el
// semáforo oficial) para quién puede disparar el análisis automático de
// imágenes de comunicados. Acepta tanto IDs numéricos como @usuarios, para
// no depender de conseguir el ID numérico de cada colaborador.
// Variable: COLABORADORES_IMAGENES="123456,@vivigo81,@otrocolaborador"
function esColaboradorImagenes(ctx) {
  const lista = (process.env.COLABORADORES_IMAGENES || process.env.ADMIN_TELEGRAM_ID || "")
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
async function reenviarMediaAlAdmin(ctx, tipo) {
  if (!esChatAutorizado(ctx)) return;
  if (!process.env.ADMIN_TELEGRAM_ID) return;
  try {
    const from = ctx.from || {};
    const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
    const origen = ctx.chat?.type === "private" ? "por privado" : `en el grupo (${ctx.chat?.title || "sin nombre"})`;

    // file_id según el tipo de media — para las fotos, Telegram manda un
    // array de tamaños, nos quedamos con el más grande (el último).
    const fileId =
      ctx.message?.photo?.[ctx.message.photo.length - 1]?.file_id ??
      ctx.message?.voice?.file_id ??
      ctx.message?.audio?.file_id ??
      ctx.message?.video?.file_id ??
      ctx.message?.video_note?.file_id ??
      null;

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

    await bot.telegram.sendMessage(
      process.env.ADMIN_TELEGRAM_ID,
      `📎 Recibí un(a) ${tipo} de ${quien} ${origen}:${lineaLink}`
    );
    await ctx.forwardMessage(process.env.ADMIN_TELEGRAM_ID);
  } catch (err) {
    console.error(`Error reenviando ${tipo} al admin:`, err.message);
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

// Fuerza un chequeo manual del monitor de X (útil para probar sin esperar
// al ping externo, y para forzar una actualización si hace falta).
bot.command("chequeox", async (ctx) => {
  if (String(ctx.from?.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
  await ctx.reply("Chequeando @InfoTSarmiento...");
  try {
    const resultado = await chequearYActualizarDesdeX();
    if (resultado.actualizado) {
      await ctx.reply(`✅ Estado actualizado desde X: ${resultado.estado}\n"${resultado.texto}"`);
    } else {
      await ctx.reply(`Sin cambios: ${resultado.motivo}${resultado.texto ? `\n"${resultado.texto}"` : ""}`);
    }
  } catch (err) {
    console.error("Error en /chequeox:", err.message);
    await ctx.reply("Falló el chequeo: " + err.message);
  }
});

// Si la foto la manda alguien de esColaboradorImagenes() (piloto: por ahora
// vos; después se suman colaboradores por @usuario sin tocar código), la
// trata como un posible comunicado oficial y la analiza con Gemini Vision
// en vez de solo reenviarla. Para cualquier otra persona, sigue
// funcionando como antes (reenvío simple).
bot.on("photo", async (ctx) => {
  if (esColaboradorImagenes(ctx)) {
    await procesarComunicadoDeImagen(ctx);
  } else {
    await reenviarMediaAlAdmin(ctx, "imagen");
  }
});

async function procesarComunicadoDeImagen(ctx) {
  try {
    await ctx.sendChatAction("typing");
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const fileUrl = await bot.telegram.getFileLink(fileId);
    const res = await fetch(fileUrl.href);
    if (!res.ok) throw new Error(`No pude descargar la imagen de Telegram (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");

    const datos = await analizarComunicadoImagen(base64);
    const from = ctx.from || {};
    const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
    const esElAdminPrincipal = String(from.id) === String(process.env.ADMIN_TELEGRAM_ID);

    if (!datos.esComunicadoRelevante) {
      await ctx.reply(
        "No me pareció un comunicado oficial de transporte, así que no lo guardé como fuente de la verdad. Si me equivoco, contame qué decía y lo cargo a mano.",
        ctx.chat?.type !== "private" ? opcionesRespuesta(ctx) : undefined
      );
      return;
    }

    await guardarComunicado(datos, { quien, userId: from.id });

    const resumenTexto =
      `📋 Comunicado guardado como fuente de la verdad (subido por ${quien}):\n\n` +
      `Tipo: ${datos.tipo}\n` +
      `Fecha: ${datos.fecha || "no especificada"}\n` +
      `Horario: ${datos.horario || "no especificado"}\n` +
      `Resumen: ${datos.resumen}\n\n` +
      `A partir de ahora el bot puede usar este dato al responder preguntas relacionadas.`;

    await ctx.reply(resumenTexto, ctx.chat?.type !== "private" ? opcionesRespuesta(ctx) : undefined);

    // Si quien subió la imagen NO sos vos, te avisa siempre por separado —
    // así te enterás aunque no hayas estado mirando el grupo en ese momento.
    if (!esElAdminPrincipal && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram
        .sendMessage(process.env.ADMIN_TELEGRAM_ID, resumenTexto)
        .catch((err) => console.error("Error avisando al admin sobre comunicado de colaborador:", err.message));
    }
  } catch (err) {
    console.error("Error procesando imagen de comunicado:", err.message);
    await ctx.reply("No pude leer la imagen: " + err.message).catch(() => {});
  }
}

bot.on("voice", (ctx) => reenviarMediaAlAdmin(ctx, "audio/nota de voz"));
bot.on("audio", (ctx) => reenviarMediaAlAdmin(ctx, "audio"));
bot.on("video", (ctx) => reenviarMediaAlAdmin(ctx, "video"));
bot.on("video_note", (ctx) => reenviarMediaAlAdmin(ctx, "video nota"));

bot.on("text", async (ctx) => {
  let preguntaParaReintento = null;
  try {
    if (!esChatAutorizado(ctx)) return;

    const textoOriginal = ctx.message.text;
    const esGrupo = ctx.chat?.type !== "private";
    const esChatPrivado = !esGrupo;

    // Alimenta la señal informal de "nadie se queja" — se registra SIEMPRE
    // que sea un mensaje de grupo, aunque no le hablen al bot directamente.
    if (esGrupo) registrarMensajeGrupo(textoOriginal, ctx.from?.id);

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
    // Al aire (sin mención): intenta responder siempre que el tema suene
    // relevante — si no tiene una respuesta concreta, se queda callado
    // (ver manejarSinRespuesta). Si lo mencionan, SIEMPRE responde, y si no
    // sabe, lo dice con honestidad. Es la lógica fija, no un toggle.
    // Si el mensaje es una respuesta (reply) a OTRA PERSONA (no al bot), es
    // casi seguro parte de una charla entre usuarios — el bot no debe meterse
    // ahí aunque las palabras coincidan con el filtro de tema/pregunta.
    const esReplyAOtraPersona =
      ctx.message.reply_to_message && ctx.message.reply_to_message.from?.username !== botUsername;

    const esPreguntaAlAire =
      esGrupo && !fueEtiquetado && !esReplyAOtraPersona && pareceConsultaRelevante(textoOriginal);

    if (!fueEtiquetado && !esPreguntaAlAire) return;

    const pregunta = limpiarMencion(textoOriginal);
    if (!pregunta) return;
    preguntaParaReintento = pregunta;

    // Límite de uso por persona: protege la cuota gratuita de Gemini.
    if (excedioLimite(ctx.from?.id)) {
      if (fueEtiquetado) {
        await ctx.reply(
          "Che, me preguntaste bastante seguido 😅 esperá unos minutos y probá de nuevo.",
          opcionesRespuesta(ctx)
        );
      }
      // Si fue una pregunta al aire, directamente no contesta nada.
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
    }
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
  if (!secretValido) {
    return res.status(403).send("forbidden");
  }
  try {
    const desdeX = await chequearYActualizarDesdeX();
    if (desdeX.avisarFalloPersistente && process.env.ADMIN_TELEGRAM_ID) {
      await bot.telegram
        .sendMessage(
          process.env.ADMIN_TELEGRAM_ID,
          `⚠️ El monitoreo de X (@InfoTSarmiento) lleva ${desdeX.fallosConsecutivos} chequeos seguidos sin poder leer ninguna instancia de Nitter. Puede que todas estén caídas — no te va a volver a avisar de esto hasta que se resuelva solo o reinicies el servicio.`
        )
        .catch(() => {});
    }
    const resultado = await chequearYNotificar(bot);
    const informeDiario = await chequearYEnviarInformeDiario(bot);
    const reintentos = await procesarColaReintentos();
    res.json({ ...resultado, informeDiario, reintentos, desdeX });
  } catch (err) {
    console.error("Error en /internal/check:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
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
