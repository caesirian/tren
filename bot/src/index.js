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

import { TREN_SARMIENTO_INFO, RESPUESTA_SIN_DATO } from "./staticData.js";
import { getEstadoServicio } from "./firestoreStatus.js";
import { getAlertasTrenes } from "./apiTransporte.js";
import { responderPregunta } from "./gemini.js";
import { detectarEstacion, proximosTrenesEnEstacion, ultimosTrenes, horaArgentinaTexto, proximosLocales } from "./schedule.js";

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

async function armarContexto(pregunta) {
  const partes = [TREN_SARMIENTO_INFO];

  const estado = await getEstadoServicio();
  if (estado) {
    partes.push(
      `\n== ESTADO EN VIVO (semáforo trensarmientoenlinea.com.ar) ==\nEstado: ${estado.estado}\nMensaje: ${estado.mensaje}\nActualizado: ${estado.actualizado ?? "desconocido"}`
    );
  }

  const alertas = await getAlertasTrenes();
  if (alertas) {
    partes.push(`\n== ALERTAS API TRANSPORTE ==\n${JSON.stringify(alertas)}`);
  }

  // Si la pregunta menciona una estación, calculamos horarios reales de HOY
  // usando el mismo cronograma que trensarmientoenlinea.com.ar (no aproximado).
  const estacion = detectarEstacion(pregunta);
  if (estacion) {
    const ahora = new Date();
    const proximos = proximosTrenesEnEstacion({ estacionId: estacion.id, ahora });
    const ultimos = ultimosTrenes(ahora);
    partes.push(`
== HORARIOS REALES CALCULADOS AHORA PARA "${estacion.name}" (cronograma oficial, hora actual en Buenos Aires: ${horaArgentinaTexto(ahora)}) ==
Próximos trenes hacia Moreno desde ${estacion.name}: ${proximos.haciaMoreno.map((t) => `${t.hora} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy"}
Próximos trenes hacia Once desde ${estacion.name}: ${proximos.haciaOnce.map((t) => `${t.hora} (en ${t.enMinutos} min)`).join(", ") || "no quedan más hoy"}
Último tren de hoy (${ultimos.diaTipo === "lv" ? "día hábil" : ultimos.diaTipo === "sab" ? "sábado" : "domingo/feriado"}) saliendo de Once: ${ultimos.desdeOnce.ultimo} (penúltimo: ${ultimos.desdeOnce.penultimo})
Último tren de hoy saliendo de Moreno: ${ultimos.desdeMoreno.ultimo} (penúltimo: ${ultimos.desdeMoreno.penultimo})
Estos horarios están calculados en el momento con el cronograma base oficial vigente y son la fuente más precisa disponible — no derives a la app si esta sección ya responde la pregunta.`);

    const locales = proximosLocales(estacion.name, ahora);
    partes.push(`
== "LOCALES" (formaciones que arrancan VACÍAS) EN "${estacion.name}" ==
IMPORTANTE: un "local" NO es cualquier tren que pasa por la estación — es una formación puntual que arranca vacía ahí mismo, muy buscada porque conviene subirse antes de que se llene. Solo existen en días hábiles.
${
  locales.length
    ? locales.map((l) => `${l.hora} ${l.direccion} (en ${l.enMinutos} min)`).join(", ")
    : "No hay ningún local designado en esta estación hoy (o ya pasaron todos), aunque sí puede tomar cualquier tren regular con los horarios de arriba."
}`);
  }

  return partes.join("\n");
}

bot.start((ctx) =>
  ctx.reply(
    "¡Hola! Soy el asistente del Tren Sarmiento 🚆. Preguntame por horarios, frecuencias, tarifas, estado del servicio o combinaciones con otros transportes del AMBA. En el grupo, mencioná mi usuario o respondeme un mensaje para que te vea."
  )
);

bot.help((ctx) =>
  ctx.reply(
    "Ejemplos:\n- ¿Cada cuánto pasa el tren en hora pico?\n- ¿Cuánto sale el boleto?\n- ¿Cómo va el servicio ahora?\n- ¿Con qué combina en Once?"
  )
);

bot.on("text", async (ctx) => {
  try {
    const textoOriginal = ctx.message.text;
    const esGrupo = ctx.chat?.type !== "private";
    const fueEtiquetado = mencionaAlBot(ctx);
    const esPreguntaAlAire =
      esGrupo && !fueEtiquetado && process.env.RESPONDER_SIN_MENCION === "true" &&
      pareceConsultaRelevante(textoOriginal);

    if (!fueEtiquetado && !esPreguntaAlAire) return;

    const pregunta = limpiarMencion(textoOriginal);
    if (!pregunta) return;

    const cacheKey = pregunta.toLowerCase().trim();
    const cacheada = cache.get(cacheKey);
    if (cacheada) {
      await ctx.reply(cacheada, { reply_to_message_id: ctx.message.message_id });
      return;
    }

    await ctx.sendChatAction("typing");
    const contexto = await armarContexto(pregunta);
    const respuesta = await responderPregunta({ pregunta, contexto });

    cache.set(cacheKey, respuesta);
    await ctx.reply(respuesta, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error("Error respondiendo mensaje:", err);
    await ctx.reply(RESPUESTA_SIN_DATO);
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
