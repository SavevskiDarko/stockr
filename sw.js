/**
 * Stockr Service Worker
 * ─────────────────────
 * Provides offline support and app-like loading for the PWA.
 *
 * IMPORTANT: bump VERSION on EVERY deploy so users get the new code.
 * The old cache is deleted automatically when VERSION changes.
 */
const VERSION = 'stockr-v1.0.3';
const CACHE = VERSION;

// App shell — the files needed to load the app offline.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

// Network-first for these (always want fresh data when online)
const NETWORK_FIRST = [
  'finnhub.io',
  'trading212.com',
  'workers.dev',
  'yahoo.com',
  'firestore.googleapis.com',
  'api.anthropic.com',
  'polygon.io'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
    // NOTE: no skipWaiting() here — we let the new worker WAIT so the app
    // can show the "New version available" prompt. The user taps it, which
    // posts 'skipWaiting' (handled below) to activate the update.
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Only handle GET
  if (e.request.method !== 'GET') return;

  // API / live-data requests → network-first, fall back to cache if offline
  if (NETWORK_FIRST.some((host) => url.includes(host))) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell & static assets → cache-first, update in background
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          // Cache same-origin successful responses
          if (res && res.status === 200 && url.startsWith(self.location.origin)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Allow the page to trigger an immediate update
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
