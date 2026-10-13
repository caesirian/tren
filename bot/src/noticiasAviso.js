// src/noticiasAviso.js
// Cuando se publica una noticia nueva, espera a que su página (con vista previa Open Graph) esté online
// y manda UN mensaje al grupo de Telegram con el link, así la tarjeta se ve en el propio grupo.
//
// Config (Render): usa ALLOWED_GROUP_ID. Opcionales: TEMA_NOTICIAS_ID (tema/hilo del grupo donde avisar),
// AVISAR_NOTICIAS_TELEGRAM=0 para apagarlo. Evita duplicados con el campo `avisadoTelegram` en Firestore y
// solo avisa noticias creadas hace menos de 30 minutos.

const BASE = "https://trensarmientoenlinea.com.ar";
let deps = { enviar: null, getDb: null };
const enCurso = new Set();

export function configurarAvisoNoticias(d) {
  deps = d;
}

// Mismo criterio que scripts/generar-noticias.mjs y que index.html/mod.html (si difieren, el 404.html igual resuelve por id).
export function slugNoticia(titulo) {
  const full=String(titulo||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");if(full.length<=60)return full;const cut=full.slice(0,60);return(full[60]==="-"?cut:cut.slice(0,Math.max(cut.lastIndexOf("-"),20))).replace(/-+$/,"");
}
export function urlNoticia(id, titulo) {
  const slug = slugNoticia(titulo);
  return `${BASE}/noticias/${slug ? slug + "-" : ""}${id}/`;
}

const habilitado = () =>
  !!process.env.ALLOWED_GROUP_ID && !["0", "off", "false"].includes(String(process.env.AVISAR_NOTICIAS_TELEGRAM || "").toLowerCase());
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function paginaLista(url) {
  try {
    const r = await fetch(url + "?_=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function anunciar(id) {
  const db = deps.getDb();
  if (!db) return;
  const ref = db.collection("noticias").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const n = snap.data();
  if (n.publicado === false || n.avisadoTelegram) return;
  const creado = n.creadoEn?.toMillis?.() ?? 0;
  if (!creado || Date.now() - creado > 30 * 60 * 1000) return; // solo noticias recién publicadas

  const url = urlNoticia(id, n.titulo);
  for (let i = 0; i < 36; i++) { // hasta ~6 min esperando que GitHub Pages publique la página
    if (await paginaLista(url)) break;
    await esperar(10000);
  }

  const otra = await ref.get(); // por si mientras tanto se despublicó o ya se avisó
  const m = otra.data();
  if (!m || m.publicado === false || m.avisadoTelegram) return;
  await deps.enviar(`📰 ${String(m.titulo || "Nueva noticia").slice(0, 200)}\n\n${url}`);
  await ref.update({ avisadoTelegram: true });
  console.log("noticiasAviso: avisado en Telegram", id);
}

export function programarAvisoNoticia(id) {
  if (!habilitado() || !deps.enviar || !deps.getDb) return false;
  if (!/^[A-Za-z0-9]{20}$/.test(id || "") || enCurso.has(id)) return false;
  enCurso.add(id);
  anunciar(id)
    .catch((e) => console.error("noticiasAviso:", e.message))
    .finally(() => enCurso.delete(id));
  return true;
}
