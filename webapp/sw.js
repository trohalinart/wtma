self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A minimal fetch handler (network-only). Required for installability checks in many browsers.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Prevent a known Chrome issue:
  // "only-if-cached" requests must be same-origin, otherwise `fetch()` throws.
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
  event.respondWith(fetch(event.request));
});
