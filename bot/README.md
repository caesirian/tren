# Bot Tren Sarmiento En Línea

Bot de Telegram gratuito (sin suscripción) para el grupo de la comunidad del
Tren Sarmiento. Responde en lenguaje natural preguntas sobre horarios,
frecuencias, tarifas y transporte público del AMBA, usando Gemini + datos
propios (fijos y en vivo).

## 1. Crear el bot en Telegram

1. Hablá con **@BotFather** en Telegram.
2. `/newbot` → elegí nombre y username (debe terminar en `bot`, ej. `TrenSarmientoBot`).
3. Guardá el **token** que te da → va en `TELEGRAM_BOT_TOKEN`.
4. Muy importante para que funcione en grupos: `/setprivacy` → elegí tu bot →
   **Disable**. Así el bot puede leer los mensajes del grupo cuando lo
   mencionan (con privacy mode "Enable", Telegram no le muestra el texto).
5. Agregá el bot al grupo del Tren Sarmiento.

## 2. Conseguir la API key de Gemini (gratis)

1. Entrá a https://aistudio.google.com/apikey con tu cuenta de Google.
2. Creá una API key → va en `GEMINI_API_KEY`.
3. El free tier de Gemini 2.0 Flash tiene cupo diario gratuito, más que
   suficiente para un grupo de Telegram (el bot además cachea respuestas
   repetidas 2 minutos para cuidar la cuota).

## 3. Semáforo de estado en vivo (opcional pero recomendado)

Reutiliza el mismo proyecto Firebase del sitio:

1. Firebase Console → tu proyecto → ⚙️ → Cuentas de servicio → **Generar
   nueva clave privada** (descarga un JSON).
2. De ese JSON copiás a las variables de entorno:
   - `FIREBASE_PROJECT_ID` = `project_id`
   - `FIREBASE_CLIENT_EMAIL` = `client_email`
   - `FIREBASE_PRIVATE_KEY` = `private_key` (pegala tal cual, con los `\n`)
3. En `src/firestoreStatus.js` ajustá el nombre de la colección/documento
   (`estadoServicio/sarmiento`) para que coincida con el que ya usás en
   `mod.html` para el semáforo.

Si no lo configurás, el bot funciona igual, solo que sin el dato de estado
en vivo (usa las frecuencias orientativas fijas).

## 4. API Transporte oficial (opcional, verificar antes de activar)

Al armar este bot, la página de datos abiertos de Buenos Aires indicaba que
los feeds de trenes en tiempo real de esta API estaban **suspendidos / en
revisión**. Antes de activarla:

1. Registrate en https://www.buenosaires.gob.ar/form/formulario-de-registro-api-transporte
2. Probá el endpoint de alertas de trenes a mano (Postman o `curl`) con tus
   credenciales para confirmar que devuelve datos frescos.
3. Si funciona, poné `USE_API_TRANSPORTE=true` y cargá
   `API_TRANSPORTE_CLIENT_ID` / `API_TRANSPORTE_CLIENT_SECRET`.
4. Revisá el path del endpoint en `src/apiTransporte.js` contra la
   documentación oficial vigente (puede variar).

Si no está disponible, dejalo en `false` — el bot no lo necesita para
funcionar bien.

## 5. Deploy gratis en Render

1. Subí esta carpeta a un repo de GitHub (ej. junto a tus otros proyectos).
2. Render → New → Web Service → conectá el repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Plan: **Free**.
5. Cargá todas las variables de entorno del `.env.example` en el panel de
   Render (Environment).
6. Una vez deployado, copiá la URL pública que te da Render
   (`https://tu-bot.onrender.com`) y cargala en la variable `PUBLIC_URL`
   dentro de Render, luego hacé un redeploy manual para que el bot
   configure el webhook automáticamente al arrancar.

> Nota sobre el free tier: Render "duerme" el servicio tras ~15 min sin
> tráfico. Como usamos **webhook** (no polling), esto no rompe nada: cuando
> llega un mensaje, Render despierta el servicio y responde con algunos
> segundos de demora la primera vez. No hace falta pagar ni mantenerlo
> despierto con pings.

## 6. Probarlo

En el grupo, mencioná al bot o respondé uno de sus mensajes:

> @TrenSarmientoBot ¿cada cuánto pasa el tren ahora?

En chat privado con el bot no hace falta mencionarlo, responde todo.

## 7. Mantenimiento

- Actualizar tarifas/frecuencias: editar `src/staticData.js` y volver a
  deployar (o mover ese contenido a Firestore más adelante si querés
  editarlo sin tocar código).
- Los logs de errores quedan en el dashboard de Render (pestaña Logs).
