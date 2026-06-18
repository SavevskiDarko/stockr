// ── STOCKR SERVICE WORKER ──────────────────────────
// Bump this version on EVERY deploy — this is the cache-buster
const VERSION = 'stockr-v40';
const CACHE = `stockr-${VERSION}`;

// Files to pre-cache on install
const PRECACHE = ['./', './manifest.json', './icon-192.png', './icon-512.png'];

// ── INSTALL ──
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {})
  );
});

// ── ACTIVATE: delete old caches + notify clients ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(allClients => {
        allClients.forEach(client =>
          client.postMessage({ type: 'SW_UPDATED', version: VERSION })
        );
      })
  );
});

// ── FETCH: only intercept same-origin requests ──
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never intercept external API calls (Yahoo, Firebase, Anthropic, etc.)
  if (!url.startsWith(self.location.origin)) return;
  if (e.request.method !== 'GET') return;

  // HTML navigation — network first, fall back to cache
  const isHTML = e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone(); // clone BEFORE returning
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets (icons, manifest) — cache first, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone(); // clone BEFORE returning
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
