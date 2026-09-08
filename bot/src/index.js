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

async function armarContexto() {
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
    const contexto = await armarContexto();
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
