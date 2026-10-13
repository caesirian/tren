// Genera una página estática por noticia (con Open Graph) a partir de Firestore.
// Uso:  node scripts/generar-noticias.mjs            (lee Firestore vía REST)
//       node scripts/generar-noticias.mjs fixture.json   (modo prueba, sin red)
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// sharp es opcional: sin él se usa la imagen por defecto en vez de la tarjeta con el título.
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { console.warn('sharp no disponible: sin tarjetas de imagen'); }

const PROJECT  = 'tren-sarmiento-en-linea';
const BASE     = 'https://trensarmientoenlinea.com.ar';
const SITE     = 'Tren Sarmiento En Línea';
const TWITTER  = '@trensarmientoffcc';
const FALLBACK = `${BASE}/banner.png`;
let SITIO_IMG = FALLBACK; // pasa a /og-sitio.jpg si se pudo generar
const OUT_DIR  = 'noticias';
const TZ       = 'America/Argentina/Buenos_Aires';

// ── Firestore REST ─────────────────────────────────────────────
function val(v) {
  if (!v) return undefined;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('nullValue'      in v) return null;
  return undefined;
}
function parseDoc(d) {
  const f = {};
  for (const [k, v] of Object.entries(d.fields || {})) f[k] = val(v);
  return { id: d.name.split('/').pop(), updateTime: d.updateTime, ...f };
}
async function fetchNoticias() {
  const docs = [];
  let token = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/noticias?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore REST ${res.status}: ${await res.text()}`);
    const json = await res.json();
    (json.documents || []).forEach(d => docs.push(parseDoc(d)));
    token = json.nextPageToken || '';
  } while (token);
  return docs;
}

// ── Helpers ────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plain(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, cut.lastIndexOf(' ') > n * 0.6 ? cut.lastIndexOf(' ') : cut.length).replace(/[.,;:\s]+$/, '') + '…';
}
const fmtCorta = ms => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
const fmtLarga = ms => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(ms);

// Descripción para la vista previa: 1–2 oraciones (~160 caracteres), sin repetir el título.
function descripcion(contenido, titulo) {
  let t = plain(contenido);
  const tt = plain(titulo);
  if (tt && t.toLowerCase().startsWith(tt.toLowerCase())) t = t.slice(tt.length).replace(/^[\s.:–—-]+/, '');
  if (!t) return 'Novedades del servicio del Tren Sarmiento.';
  if (t.length <= 170) return t;
  const corte = t.slice(0, 170);
  const idx = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '));
  return idx >= 90 ? corte.slice(0, idx + 1) : truncate(t, 160);
}

// Tarjeta 1200x630 con marca y título (para noticias sin foto). WhatsApp ignora imágenes de más de ~300 KB.
function envolver(texto, max, lineas) {
  const out = []; let linea = '';
  for (const w of texto.split(/\s+/)) {
    if ((linea + ' ' + w).trim().length > max && linea) { out.push(linea); linea = w; } else linea = (linea + ' ' + w).trim();
  }
  if (linea) out.push(linea);
  if (out.length > lineas) { out.length = lineas; out[lineas - 1] = out[lineas - 1].replace(/[.,;:\s]+$/, '').slice(0, max - 1) + '…'; }
  return out;
}
async function tarjeta({ titulo, kicker, fecha }) {
  const fs = titulo.length <= 60 ? 68 : titulo.length <= 100 ? 58 : 48;
  const maxLineas = fs === 48 ? 5 : 4;
  const lineas = envolver(titulo, Math.floor(1056 / (fs * 0.62)), maxLineas);
  const lh = Math.round(fs * 1.2);
  const tspans = lineas.map((l, i) => `<tspan x="72" dy="${i === 0 ? 0 : lh}">${esc(l)}</tspan>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#002B5C"/><stop offset="1" stop-color="#0A4A8A"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/><rect width="18" height="630" fill="#0095D4"/>
<g font-family="'DejaVu Sans','Liberation Sans',Arial,sans-serif" font-weight="700">
<text x="72" y="104" font-size="26" letter-spacing="3" fill="#7CC8EE">${esc(kicker)}</text>
<text x="72" y="210" font-size="${fs}" fill="#FFFFFF">${tspans}</text>
<rect x="72" y="540" width="1056" height="2" fill="#0095D4" opacity=".7"/>
<text x="72" y="590" font-size="28" fill="#7CC8EE">trensarmientoenlinea.com.ar</text>
${fecha ? `<text x="1128" y="590" font-size="28" fill="#FFFFFF" text-anchor="end">${esc(fecha)}</text>` : ''}
</g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

// Foto de Cloudinary → 1200x630, bajando la calidad si pesa más de ~290 KB. Otra URL → tal cual.
async function pesoOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const len = Number(r.headers.get('content-length'));
    return r.ok && len ? len <= 290 * 1024 : true;
  } catch { return true; }
}
async function imagenFoto(foto) {
  const m = foto.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/);
  if (!m) return { url: foto, sized: false };
  const rest = m[2].replace(/^((?:[a-z]{1,3}_[^/,]+(?:,[a-z]{1,3}_[^/,]+)*)\/)+/, '');
  let url;
  for (const q of ['q_auto', 'q_60', 'q_45']) {
    url = `${m[1]}c_fill,g_auto,w_1200,h_630,${q},f_jpg/${rest}`;
    if (await pesoOk(url)) break;
  }
  return { url, sized: true };
}
// Imagen de vista previa de una noticia: su foto o una tarjeta con el título.
async function imagenNoticia(n) {
  const titulo = plain(n.titulo) || 'Noticia';
  if (n.foto) return { ...(await imagenFoto(n.foto)), alt: titulo };
  if (!sharp) return { url: FALLBACK, sized: false, alt: SITE };
  const hash = createHash('sha1').update(titulo + '|' + (n.fechaMs || '')).digest('hex').slice(0, 8);
  const nombre = `og-${hash}.jpg`;
  const dir = path.join(OUT_DIR, n.id);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) if (/^og-.*\.jpg$/.test(f) && f !== nombre) await rm(path.join(dir, f));
  await writeFile(path.join(dir, nombre), await tarjeta({ titulo, kicker: 'NOTICIAS · TREN SARMIENTO', fecha: n.fechaMs ? fmtCorta(n.fechaMs) : '' }));
  return { url: `${BASE}/noticias/${n.id}/${nombre}`, sized: true, type: 'image/jpeg', alt: titulo };
}

// ── Plantillas ─────────────────────────────────────────────────
const CSS = `
:root{--navy:#002B5C;--celeste:#0095D4;--cel-bg:#EEF6FB;--bg:#F2F7FB;--card:#fff;--muted:#5A7A99;--border:#CDDAEA;--text:#1b2b3c}
@media(prefers-color-scheme:dark){:root{--bg:#0b1623;--card:#122236;--cel-bg:#16314d;--muted:#8fa9c4;--border:#24405e;--text:#e6eef7;--navy:#9fd3f2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:#002B5C;color:#fff;padding:14px 20px}header a{color:#fff;text-decoration:none;font-weight:700}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}
article{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
article img.foto{display:block;width:100%;height:auto}
.in{padding:20px 22px 24px}h1{font-size:1.6rem;line-height:1.25;margin:0 0 6px;color:var(--navy)}
.fecha{font-size:.82rem;color:var(--muted);margin-bottom:16px}.cuerpo p{margin:0 0 12px}.cuerpo img{max-width:100%;border-radius:8px}
.pie{font-size:.78rem;color:var(--muted);font-style:italic;margin-top:14px}
.acciones{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px;padding-top:16px;border-top:1px solid var(--border)}
.btn{display:inline-block;padding:9px 16px;border-radius:999px;border:1px solid var(--celeste);color:var(--celeste);background:transparent;font:inherit;font-size:.88rem;text-decoration:none;cursor:pointer}
.btn.pri{background:var(--celeste);color:#fff}.volver{display:block;margin-top:18px;text-align:center}
ul.lista{list-style:none;margin:0;padding:0}ul.lista li{border-bottom:1px solid var(--border);padding:14px 0}ul.lista a{color:var(--navy);font-weight:700;text-decoration:none}
ul.lista small{display:block;color:var(--muted)}`;

function paginaNoticia(n) {
  const url   = `${BASE}/noticias/${n.id}/`;
  const desc  = n._desc;
  const titulo = plain(n.titulo) || 'Noticia';
  const img   = n._og;
  const iso   = n.fechaMs ? new Date(n.fechaMs).toISOString() : undefined;
  const mod   = n.updateTime || iso;
  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: truncate(titulo, 110), description: desc, image: [img.url],
    mainEntityOfPage: url, inLanguage: 'es-AR',
    ...(iso && { datePublished: iso }), ...(mod && { dateModified: mod }),
    publisher: { '@type': 'Organization', name: SITE, url: BASE + '/' }
  };
  const wa = `https://wa.me/?text=${encodeURIComponent(`${titulo}\n${url}`)}`;
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(titulo)} | ${SITE}</title>
<meta name="description" content="${esc(desc)}"/>
<meta name="robots" content="index, follow, max-image-preview:large"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="${SITE}"/>
<meta property="og:locale" content="es_AR"/>
<meta property="og:url" content="${url}"/>
<meta property="og:title" content="${esc(truncate(titulo, 90))}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:image" content="${esc(img.url)}"/>
<meta property="og:image:alt" content="${esc(img.alt)}"/>\n${img.sized ? '<meta property="og:image:width" content="1200"/>\n<meta property="og:image:height" content="630"/>\n' : ''}${img.type ? `<meta property="og:image:type" content="${img.type}"/>\n` : ''}${iso ? `<meta property="article:published_time" content="${iso}"/>\n` : ''}<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:site" content="${TWITTER}"/>
<meta name="twitter:title" content="${esc(truncate(titulo, 70))}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
<meta name="twitter:image" content="${esc(img.url)}"/>
<meta name="twitter:image:alt" content="${esc(img.alt)}"/>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>${CSS}</style>
</head>
<body>
<header><a href="/">🚆 ${SITE}</a></header>
<main>
<article>
${n.foto ? `<img class="foto" src="${esc(n.foto)}" alt="${esc(titulo)}"/>` : ''}
<div class="in">
<h1>${n.titulo || ''}</h1>
<div class="fecha">${n.fechaMs ? fmtLarga(n.fechaMs) : ''}</div>
<div class="cuerpo">${n.contenido || ''}</div>
${n.piedefoto ? `<p class="pie">📷 ${n.piedefoto}</p>` : ''}
<div class="acciones">
<a class="btn pri" href="${wa}" rel="noopener">Compartir por WhatsApp</a>
<button class="btn" type="button" id="cp" data-url="${url}">🔗 Copiar link</button>
</div>
</div>
</article>
<a class="btn volver" href="/">Ver estado del servicio y próximos trenes →</a>
<a class="btn volver" href="/noticias/" style="border:none">Todas las noticias</a>
</main>
<script>
document.getElementById('cp').addEventListener('click',function(){var b=this;navigator.clipboard.writeText(b.dataset.url).then(function(){b.textContent='✅ Link copiado';setTimeout(function(){b.textContent='🔗 Copiar link'},2000)}).catch(function(){b.textContent=b.dataset.url})});
</script>
</body>
</html>
`;
}

function paginaIndice(items) {
  const url = `${BASE}/noticias/`;
  const desc = 'Noticias y novedades del servicio del Tren Sarmiento, ramal Once–Moreno.';
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Noticias | ${SITE}</title>
<meta name="description" content="${desc}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="${SITE}"/>
<meta property="og:locale" content="es_AR"/>
<meta property="og:url" content="${url}"/>
<meta property="og:title" content="Noticias | ${SITE}"/>
<meta property="og:description" content="${desc}"/>
<meta property="og:image" content="${SITIO_IMG}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${SITIO_IMG}"/>
<style>${CSS}</style>
</head>
<body>
<header><a href="/">🚆 ${SITE}</a></header>
<main>
<h1 style="margin:8px 0 12px;color:var(--navy)">📰 Noticias</h1>
<ul class="lista">
${items.map(n => `<li><a href="/noticias/${n.id}/">${n.titulo || 'Noticia'}</a><small>${n.fechaMs ? fmtCorta(n.fechaMs) : ''}</small></li>`).join('\n') || '<li>Todavía no hay noticias.</li>'}
</ul>
<a class="btn volver" href="/">Volver al inicio</a>
</main>
</body>
</html>
`;
}

function sitemap(items) {
  const urls = [{ loc: `${BASE}/noticias/`, lastmod: items[0]?.updateTime }, ...items.map(n => ({ loc: `${BASE}/noticias/${n.id}/`, lastmod: n.updateTime || (n.fechaMs && new Date(n.fechaMs).toISOString()) }))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
}

// ── Main ───────────────────────────────────────────────────────
const fixture = process.argv[2];
const todas = fixture ? JSON.parse(await readFile(fixture, 'utf8')) : await fetchNoticias();
const items = todas
  .filter(n => n.publicado !== false && n.titulo && n.contenido)
  .sort((a, b) => (b.fechaMs || 0) - (a.fechaMs || 0));

await mkdir(OUT_DIR, { recursive: true });
const vivos = new Set(items.map(n => n.id));
for (const entry of await readdir(OUT_DIR, { withFileTypes: true })) {
  if (entry.isDirectory() && !vivos.has(entry.name)) await rm(path.join(OUT_DIR, entry.name), { recursive: true, force: true });
}
if (sharp) {
  await writeFile('og-sitio.jpg', await tarjeta({ titulo: 'Estado del servicio, horarios y noticias del Tren Sarmiento', kicker: 'TREN SARMIENTO EN LÍNEA', fecha: '' }));
  SITIO_IMG = `${BASE}/og-sitio.jpg`;
}
for (const n of items) {
  n._desc = descripcion(n.contenido, n.titulo);
  n._og = await imagenNoticia(n);
  await mkdir(path.join(OUT_DIR, n.id), { recursive: true });
  await writeFile(path.join(OUT_DIR, n.id, 'index.html'), paginaNoticia(n));
}
await writeFile(path.join(OUT_DIR, 'index.html'), paginaIndice(items));
await writeFile('sitemap-noticias.xml', sitemap(items));
console.log(`OK: ${items.length} noticia(s) generadas`);
