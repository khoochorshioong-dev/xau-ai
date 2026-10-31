const CACHE = "xau-ai-v3-2";

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

const API_HOST = "xau-ai-api.khoochorshioong.workers.dev";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function cacheCopy(request, response) {
  /*
   * Only cache complete, successful responses.
   * Never cache errors (404 / 5xx) or partial content.
   */
  if (!response || response.status !== 200 || response.type === "opaque") {
    return;
  }

  const copy = response.clone();

  caches.open(CACHE).then(cache => cache.put(request, copy));
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }

  /*
   * API requests must ALWAYS go to the network.
   * Never cache live XAUUSD analysis.
   */
  if (url.hostname === API_HOST) {
    return;
  }

  /*
   * HTML navigation:
   * Network first.
   *
   * This ensures the iPhone receives
   * the newest GitHub Pages version.
   */
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then(response => {
          cacheCopy(request, response);
          return response;
        })
        .catch(() =>
          caches.match(request)
            .then(cached => cached || caches.match("./index.html"))
        )
    );

    return;
  }

  /*
   * Static assets:
   * Cache first, refresh in the background.
   */
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          cacheCopy(request, response);
          return response;
        });

      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }

      return network;
    })
  );
});
