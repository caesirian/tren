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
import { detectarEstacion, proximosTrenesEnEstacion, ultimosTrenes, horaArgentinaTexto, proximosLocales, proximosLocalesTodasEstaciones, proximoDiferencial, DIFERENCIAL } from "./schedule.js";
import { registrarMensajeGrupo, getSenalComunidad } from "./complaintTracker.js";
import { registrarChatPrivado } from "./privateChatLogger.js";

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

bot.on("text", async (ctx) => {
  try {
    const textoOriginal = ctx.message.text;
    const esGrupo = ctx.chat?.type !== "private";
    const esChatPrivado = !esGrupo;

    // Alimenta la señal informal de "nadie se queja" — se registra SIEMPRE
    // que sea un mensaje de grupo, aunque no le hablen al bot directamente.
    if (esGrupo) registrarMensajeGrupo(textoOriginal);

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
      if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta: cacheada });
      return;
    }

    await ctx.sendChatAction("typing");
    const contexto = await armarContexto(pregunta);
    const respuesta = await responderPregunta({ pregunta, contexto });

    cache.set(cacheKey, respuesta);
    await ctx.reply(respuesta, { reply_to_message_id: ctx.message.message_id });
    if (esChatPrivado) await registrarChatPrivado({ ctx, pregunta, respuesta });
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
