const CACHE_NAME = "mavis-expense-v1";
const ASSETS = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
  "icons/3.png"
];

// Install Event
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching static shell assets");
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("[Service Worker] Clearing old cache:", key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event (Network-first with Cache fallback)
self.addEventListener("fetch", (e) => {
  // Only handle GET requests and local/http schemes
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Cache the fresh resource
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, clone);
        });
        return res;
      })
      .catch(() => {
        // Fallback to cache if network is unavailable
        return caches.match(e.request);
      })
  );
});
