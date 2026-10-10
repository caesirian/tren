// src/noticiasSync.js
// Avisa a GitHub que regenere las páginas estáticas de noticias (/noticias/<id>/ con Open Graph)
// apenas se publica, edita o borra una noticia — en vez de esperar al cron del workflow.
//
// Requiere en Render la variable GITHUB_DISPATCH_TOKEN: token fine-grained de SOLO el repo
// caesirian/tren con permiso "Actions: Read and write". Sin token, no hace nada (queda el cron de respaldo).
// Opcionales: GITHUB_REPO (default "caesirian/tren"), GITHUB_REF (default "main").

const REPO     = process.env.GITHUB_REPO || "caesirian/tren";
const REF      = process.env.GITHUB_REF || "main";
const WORKFLOW = "noticias-og.yml";
const DEBOUNCE_MS = 2000;      // junta ráfagas (publicar + editar seguidos) en una sola corrida
const MIN_ENTRE_MS = 10000;    // tope: una corrida cada 10 s como máximo

let timer = null;
let ultimo = 0;
let avisadoSinToken = false;

async function despachar(intento = 1) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    if (!avisadoSinToken) {
      console.warn("noticiasSync: falta GITHUB_DISPATCH_TOKEN; las páginas de noticias se regeneran solo por el cron del workflow.");
      avisadoSinToken = true;
    }
    return { ok: false, motivo: "sin-token" };
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    });
    if (res.status === 204) {
      ultimo = Date.now();
      console.log("noticiasSync: workflow disparado");
      return { ok: true };
    }
    throw new Error(`GitHub respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error(`noticiasSync: error (intento ${intento}):`, err.message);
    if (intento < 2) {
      await new Promise((r) => setTimeout(r, 3000));
      return despachar(intento + 1);
    }
    return { ok: false, motivo: "error" };
  }
}

// Pide una regeneración. Es idempotente y barata: se puede llamar cuantas veces haga falta.
export function solicitarSyncNoticias() {
  if (timer) return { programado: true };
  const espera = Math.max(DEBOUNCE_MS, MIN_ENTRE_MS - (Date.now() - ultimo));
  timer = setTimeout(() => {
    timer = null;
    despachar().catch((e) => console.error("noticiasSync:", e.message));
  }, espera);
  return { programado: true, enMs: espera };
}
