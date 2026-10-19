// Service worker de Tren Sarmiento Lite. Cachea solo la "cáscara" de la app para que abra al instante
// y sin conexión; los datos en vivo (trenbot.onrender.com) NUNCA se cachean.
const VERSION = "lite-v3";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API del bot y demás: directo a la red

  // Páginas: red primero (así siempre se ve la última versión), con respaldo en caché si no hay señal.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(VERSION).then((c) => c.put("index.html", copia));
          return res;
        })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // Íconos y demás archivos de la app: caché primero, actualiza en segundo plano.
  e.respondWith(
    caches.match(req).then((hit) => {
      const red = fetch(req)
        .then((res) => {
          if (res.ok) { const copia = res.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
          return res;
        })
        .catch(() => hit);
      return hit || red;
    })
  );
});
