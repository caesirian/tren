// ══════════════════════════════════════════════════════════════
// Tren Sarmiento En Línea — Proxy para OneSignal API
// Evita el error CORS al llamar a OneSignal desde el browser.
// La REST API Key vive en la variable de entorno ONESIGNAL_REST_API_KEY
// configurada en Render (nunca en el código).
// ══════════════════════════════════════════════════════════════

const express = require('express');
const app     = express();

const PORT             = process.env.PORT || 3000;
const ONESIGNAL_APP_ID = '114f6665-eede-42d0-90ad-4d6480f10c76';
const ONESIGNAL_API    = 'https://onesignal.com/api/v1';
const API_KEY          = process.env.ONESIGNAL_REST_API_KEY;

// ── CORS: solo permite requests desde el dominio real ─────────
const ALLOWED_ORIGINS = [
  'https://trensarmientoenlinea.com.ar',
  'https://www.trensarmientoenlinea.com.ar',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tren-proxy', version: '1.0.0' });
});

// ── Diagnóstico temporal (borrar después de verificar) ────────
app.get('/diag', async (req, res) => {
  const key = process.env.ONESIGNAL_REST_API_KEY;

  // Test directo contra OneSignal para ver qué responde
  let onesignalTest = null;
  try {
    const r = await fetch(
      `${ONESIGNAL_API}/notifications?app_id=${ONESIGNAL_APP_ID}&limit=1&kind=1`,
      { headers: { 'Authorization': `Basic ${key}` } }
    );
    const data = await r.json();
    onesignalTest = { status: r.status, data };
  } catch(err) {
    onesignalTest = { error: err.message };
  }

  res.json({
    key_presente: !!key,
    key_longitud: key ? key.length : 0,
    key_inicio:   key ? key.substring(0, 10) + '...' : null,
    app_id:       ONESIGNAL_APP_ID,
    onesignal:    onesignalTest,
  });
});

// ── Enviar notificación push ──────────────────────────────────
app.post('/notif/enviar', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'API Key no configurada en el servidor.' });

  const { titulo, mensaje, url } = req.body;
  if (!titulo || !mensaje) {
    return res.status(400).json({ ok: false, error: 'Faltan título o mensaje.' });
  }

  try {
    const r = await fetch(`${ONESIGNAL_API}/notifications`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${API_KEY}`
      },
      body: JSON.stringify({
        app_id:            ONESIGNAL_APP_ID,
        included_segments: ['All'],
        headings:          { es: titulo,  en: titulo  },
        contents:          { es: mensaje, en: mensaje },
        url:               url || 'https://trensarmientoenlinea.com.ar',
        chrome_web_icon:   'https://trensarmientoenlinea.com.ar/logo.png',
        firefox_icon:      'https://trensarmientoenlinea.com.ar/logo.png',
      })
    });

    const data = await r.json();
    if (r.ok && data.id) {
      res.json({ ok: true, id: data.id, recipients: data.recipients });
    } else {
      res.status(r.status).json({ ok: false, error: data.errors || data });
    }
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Historial de notificaciones ───────────────────────────────
app.get('/notif/historial', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'API Key no configurada en el servidor.' });

  const limit  = parseInt(req.query.limit)  || 20;
  const offset = parseInt(req.query.offset) || 0;

  try {
    const r = await fetch(
      `${ONESIGNAL_API}/notifications?app_id=${ONESIGNAL_APP_ID}&limit=${limit}&offset=${offset}&kind=1`,
      { headers: { 'Authorization': `Basic ${API_KEY}` } }
    );

    const data = await r.json();
    if (r.ok) {
      res.json({ ok: true, notifications: data.notifications || [], total: data.total_count });
    } else {
      res.status(r.status).json({ ok: false, error: data.errors || data });
    }
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`tren-proxy corriendo en puerto ${PORT}`));
