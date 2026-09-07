const CACHE = "xau-ai-v3-1";

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {

  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(ASSETS);
    })
  );

  self.skipWaiting();
});


self.addEventListener("activate", event => {

  event.waitUntil(

    caches.keys().then(keys => {

      return Promise.all(

        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))

      );

    })

  );

  self.clients.claim();
});


self.addEventListener("fetch", event => {

  const request = event.request;

  /*
   * API requests must ALWAYS go to the network.
   * Never cache live XAUUSD analysis.
   */

  if(
    request.url.includes(
      "xau-ai-api.khoochorshioong.workers.dev"
    )
  ){

    event.respondWith(
      fetch(request)
    );

    return;
  }


  /*
   * HTML navigation:
   * Network first.
   *
   * This ensures the iPhone receives
   * the newest GitHub Pages version.
   */

  if(
    request.mode === "navigate" ||
    request.destination === "document"
  ){

    event.respondWith(

      fetch(request)
        .then(response => {

          const copy =
            response.clone();

          caches.open(CACHE)
            .then(cache => {
              cache.put(
                request,
                copy
              );
            });

          return response;

        })
        .catch(() => {

          return caches.match(
            request
          );

        })

    );

    return;
  }


  /*
   * Static assets:
   * Cache first.
   */

  event.respondWith(

    caches.match(request)
      .then(cached => {

        if(cached){
          return cached;
        }

        return fetch(request)
          .then(response => {

            const copy =
              response.clone();

            caches.open(CACHE)
              .then(cache => {

                cache.put(
                  request,
                  copy
                );

              });

            return response;

          });

      })

  );

});
