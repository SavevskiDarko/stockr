// ── STOCKR SERVICE WORKER ──────────────────────────
// Bump this version on EVERY deploy — this is the cache-buster
const VERSION = 'stockr-v2';
const CACHE = `stockr-${VERSION}`;

// Files to pre-cache on install
const PRECACHE = ['./', './manifest.json', './icon-192.png', './icon-512.png'];

// ── INSTALL: cache static assets ──
self.addEventListener('install', e => {
  self.skipWaiting(); // activate immediately, don't wait for old tabs to close
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {})
  );
});

// ── ACTIVATE: delete ALL old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => {
        console.log('[SW] Now controlling all clients');
        return clients.claim(); // take control of all open tabs immediately
      })
      .then(() => {
        // Tell all open tabs to reload so they get the new version
        return self.clients.matchAll({ type: 'window' });
      })
      .then(allClients => {
        allClients.forEach(client => {
          console.log('[SW] Reloading client for new version');
          client.postMessage({ type: 'SW_UPDATED', version: VERSION });
        });
      })
  );
});

// ── FETCH: network-first for HTML, cache-first for assets ──
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never intercept external API calls
  if (!url.startsWith(self.location.origin)) return;
  if (e.request.method !== 'GET') return;

  // HTML (index.html / root) — always try network first so updates appear immediately
  const isHTML = e.request.mode === 'navigate' ||
    e.request.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Cache the fresh response
          if (res && res.status === 200) {
            caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(e.request)) // offline fallback
    );
    return;
  }

  // Assets (icons, manifest) — cache-first, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      });
      return cached || network;
    })
  );
});
