const CACHE_NAME = "mavis-expense-v1";
const ASSETS = [
  "/",                 // <-- Added: Crucial for bare URL offline fallback
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
  "icons/favicon.png"
];

// Install Event
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching static shell assets");
      return cache.addAll(ASSETS);
    })
  );
  // REMOVED: self.skipWaiting() has been deleted from here
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
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, clone);
        });
        return res;
      })
      .catch(() => {
        return caches.match(e.request);
      })
  );
});

// NEW: Add message listener to safely force-install updates when requested by the UI
self.addEventListener("message", (e) => {
  if (e.data && e.data.action === "skipWaiting") {
    self.skipWaiting();
  }
});