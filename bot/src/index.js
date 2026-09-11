// src/index.js
// Bot de Telegram para el grupo de Tren Sarmiento En Línea.
// Corre como servidor Express + webhook de Telegraf, pensado para el free
// tier de Render (el free tier "duerme" tras inactividad, pero al usar
// webhook -en vez de polling- Telegram simplemente espera la respuesta
// cuando Render lo despierta; no hace falta mantenerlo despierto).

import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import NodeCache from "node-cache";

import { TREN_SARMIENTO_INFO, RESPUESTA_SIN_DATO, RESPUESTA_ERROR_TECNICO } from "./staticData.js";
import { getEstadoServicio } from "./firestoreStatus.js";
import { getAlertasTrenes } from "./apiTransporte.js";
import { responderPregunta, SIN_RESPUESTA_SENTINEL } from "./gemini.js";
import { detectarEstacion, proximosTrenesEnEstacion, ultimosTrenes, horaArgentinaTexto, proximosLocales, proximosLocalesTodasEstaciones, proximoDiferencial, DIFERENCIAL, horariosLocalesEstacion, getDayType, infoTransporteEstacion } from "./schedule.js";
import { registrarMensajeGrupo, getSenalComunidad } from "./complaintTracker.js";
import { registrarChatPrivado } from "./privateChatLogger.js";
import { consultarParoEnVivo } from "./paroSearch.js";
import { esInsulto } from "./insultDetector.js";
import { excedioLimite } from "./rateLimiter.js";

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
  "andén", "anden", "demora", "demorado", "para", "parado", "combinación",
  "combinacion", "subte", "colectivo", "amba", "moreno", "once", "liniers",
  "castelar", "morón", "moron", "merlo", "ramos mejía", "haedo", "ituzaingó",
  "perdí", "perdi", "perdido", "perdida", "encontré", "encontre", "encontrado",
  "objeto", "mochila", "celular", "olvidé", "olvide", "quedó", "quede",
];

// Palabras/signos que indican que es una pregunta.
const PISTAS_PREGUNTA = ["?", "¿", "cuándo", "cuando", "cuánto", "cuanto", "dónde", "donde", "cómo", "como", "hay", "sabe", "alguien sabe"];

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

  // Si la pregunta menciona una estación, calculamos horarios reales de HOY
  // usando el mismo cronograma que trensarmientoenlinea.com.ar (no aproximado).
  const estacion = detectarEstacion(pregunta);
  if (estacion) {
    const ahora = new Date();
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

// Reenvía al admin cualquier foto, audio, nota de voz o video que le
// manden al bot por chat PRIVADO (no en el grupo, ahí es tráfico normal).
async function reenviarMediaAlAdmin(ctx, tipo) {
  if (ctx.chat?.type !== "private") return;
  if (!process.env.ADMIN_TELEGRAM_ID) return;
  try {
    const from = ctx.from || {};
    const quien = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `ID ${from.id}`;
    await bot.telegram.sendMessage(
      process.env.ADMIN_TELEGRAM_ID,
      `📎 Recibí un(a) ${tipo} de ${quien} por privado:`
    );
    await ctx.forwardMessage(process.env.ADMIN_TELEGRAM_ID);
  } catch (err) {
    console.error(`Error reenviando ${tipo} al admin:`, err.message);
  }
}

bot.on("photo", (ctx) => reenviarMediaAlAdmin(ctx, "imagen"));
bot.on("voice", (ctx) => reenviarMediaAlAdmin(ctx, "audio/nota de voz"));
bot.on("audio", (ctx) => reenviarMediaAlAdmin(ctx, "audio"));
bot.on("video", (ctx) => reenviarMediaAlAdmin(ctx, "video"));
bot.on("video_note", (ctx) => reenviarMediaAlAdmin(ctx, "video nota"));

bot.on("text", async (ctx) => {
  try {
    if (!esChatAutorizado(ctx)) return;

    const textoOriginal = ctx.message.text;
    const esGrupo = ctx.chat?.type !== "private";
    const esChatPrivado = !esGrupo;

    // Alimenta la señal informal de "nadie se queja" — se registra SIEMPRE
    // que sea un mensaje de grupo, aunque no le hablen al bot directamente.
    if (esGrupo) registrarMensajeGrupo(textoOriginal);

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
    const esPreguntaAlAire =
      esGrupo && !fueEtiquetado && process.env.RESPONDER_SIN_MENCION === "true" &&
      pareceConsultaRelevante(textoOriginal);

    if (!fueEtiquetado && !esPreguntaAlAire) return;

    const pregunta = limpiarMencion(textoOriginal);
    if (!pregunta) return;

    // Límite de uso por persona: protege la cuota gratuita de Gemini.
    if (excedioLimite(ctx.from?.id)) {
      if (fueEtiquetado) {
        await ctx.reply(
          "Che, me preguntaste bastante seguido 😅 esperá unos minutos y probá de nuevo.",
          { reply_to_message_id: ctx.message.message_id }
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
        await ctx.reply(respuestaCacheada, { reply_to_message_id: ctx.message.message_id });
        if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta: respuestaCacheada });
      }
      return;
    }

    await ctx.sendChatAction("typing");
    const contexto = await armarContexto(pregunta);
    const respuestaCruda = await responderPregunta({ pregunta, contexto });

    cache.set(cacheKey, respuestaCruda);
    const respuesta = manejarSinRespuesta(respuestaCruda, fueEtiquetado);
    if (respuesta) {
      await ctx.reply(respuesta, { reply_to_message_id: ctx.message.message_id });
      if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta });
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
    }
    await ctx.reply(RESPUESTA_ERROR_TECNICO);
  }
});

// --- Webhook + healthcheck ---
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.get("/", (_req, res) => res.send("Bot Tren Sarmiento activo."));

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
