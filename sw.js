const CACHE = "inotes-flow-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./yandex-disk.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

// Установка: очищаем любые старые кэши
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

// Активация: немедленно берем контроль над всеми клиентами и удаляем старые версии
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(k => {
          if (k !== CACHE) {
            console.log("Удаляем старый кэш:", k);
            return caches.delete(k);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Network-First: ВСЕГДА сначала запрашиваем свежую версию из сети,
// и только при отсутствии интернета отдаём из кэша.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(networkRes => {
        if (networkRes && networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(CACHE).then(c => c.put(e.request, resClone));
        }
        return networkRes;
      })
      .catch(() => {
        return caches.match(e.request).then(cached => cached || caches.match("./index.html"));
      })
  );
});
