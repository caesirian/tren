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

// ══════════════════════════════════════════════════════════════
// SOFSE API — proxy para evitar CORS desde el browser
// Fuente: ariedro.dev/api-trenes (bypasser público de la API de SOFSE)
// Los IDs de estaciones del Sarmiento están mapeados abajo.
// ══════════════════════════════════════════════════════════════
const SOFSE_BASE = 'https://ariedro.dev/api-trenes';

// IDs confirmados del ramal Once–Moreno (obtenidos via /sofse/discovery)
// Se completan con el endpoint /sofse/discovery si falta alguno
const ESTACIONES_SARMIENTO = {
  'Once':                  null, // se pobla via discovery
  'Caballito':             null,
  'Flores':                null,
  'Floresta':              null,
  'Villa Luro':            null,
  'Liniers':               null,
  'Ciudadela':             null,
  'Ramos Mejia':           null,
  'Haedo':                 null,
  'Moron':                 null,
  'Castelar':              null,
  'Ituzaingo':             null,
  'San Antonio de Padua':  null,
  'Merlo':                 null,
  'Paso del Rey':          null,
  'Moreno':                null,
};

// ── Discovery: buscar ID de una estación por nombre ───────────
app.get('/sofse/estacion', async (req, res) => {
  const nombre = req.query.nombre;
  if (!nombre) return res.status(400).json({ ok: false, error: 'Falta parámetro nombre' });
  try {
    const r    = await fetch(`${SOFSE_BASE}/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
    const data = await r.json();
    res.json({ ok: true, estaciones: data });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Discovery masivo: poblar IDs de las 16 estaciones ─────────
app.get('/sofse/discovery', async (req, res) => {
  const nombres = Object.keys(ESTACIONES_SARMIENTO);
  const resultados = {};
  const errores    = [];

  for (const nombre of nombres) {
    try {
      const r    = await fetch(`${SOFSE_BASE}/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
      const data = await r.json();
      // Buscar coincidencia exacta o parcial con el ramal Sarmiento
      const match = Array.isArray(data)
        ? data.find(e =>
            e.nombre?.toLowerCase().includes(nombre.toLowerCase().split(' ')[0].toLowerCase()) &&
            (e.incluida_en_ramales?.length > 0 || e.operativa_en_ramales?.length > 0)
          )
        : null;
      resultados[nombre] = match
        ? { id: match.id_estacion, nombre_api: match.nombre, ramales: match.incluida_en_ramales }
        : { id: null, error: 'No encontrada' };
    } catch(err) {
      resultados[nombre] = { id: null, error: err.message };
      errores.push(nombre);
    }
    // Pausa entre requests para no saturar la API
    await new Promise(r => setTimeout(r, 150));
  }

  res.json({ ok: true, resultados, errores });
});

// ── Próximos trenes: consulta real a SOFSE ────────────────────
// GET /sofse/arribos?desde=ID&hasta=ID&cantidad=5
// La fecha y hora se toman del momento de la consulta (Argentina GMT-3)
app.get('/sofse/arribos', async (req, res) => {
  const { desde, hasta, cantidad = 5 } = req.query;
  if (!desde || !hasta) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros desde y/o hasta (IDs de estación)' });
  }

  // Hora actual en Argentina (GMT-3)
  const ahora   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const fecha   = ahora.toISOString().slice(0, 10); // YYYY-MM-DD
  const hora    = `${String(ahora.getHours()).padStart(2,'0')}:${String(ahora.getMinutes()).padStart(2,'0')}`;

  try {
    const url = `${SOFSE_BASE}/arribos/estacion/${desde}?hasta=${hasta}&fecha=${fecha}&hora=${hora}&cantidad=${cantidad}`;
    const r   = await fetch(url);

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ ok: false, error: `SOFSE devolvió ${r.status}`, detalle: txt.slice(0, 200) });
    }

    const data = await r.json();

    // Normalizar la respuesta para el frontend
    const trenes = (Array.isArray(data) ? data : data.servicios || data.trenes || [])
      .map(t => ({
        hora_salida:  t.hora_salida  || t.horario || t.hora || '—',
        hora_llegada: t.hora_llegada || null,
        destino:      t.destino      || t.ramal   || '—',
        tipo:         t.tipo         || t.clasificacion || 'regular',
        demora:       t.demora       || t.delay   || 0,
        estado:       t.estado       || 'programado',
        plataforma:   t.plataforma   || t.anden   || null,
      }));

    res.json({
      ok: true,
      desde, hasta,
      fecha, hora_consulta: hora,
      trenes,
      fuente: 'SOFSE API via ariedro.dev',
    });

  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`tren-proxy corriendo en puerto ${PORT}`));
