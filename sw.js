/**
 * Stockr Service Worker
 * ─────────────────────
 * Provides offline support and app-like loading for the PWA.
 *
 * IMPORTANT: bump VERSION on EVERY deploy so users get the new code.
 * The old cache is deleted automatically when VERSION changes.
 */
const VERSION = 'stockr-v1.14.1';
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

// ═══ PUSH NOTIFICATIONS ═══
// Pushes arrive with NO payload (v1 keeps encryption out of the Worker).
// On push, we fetch the latest alert messages the Worker wrote to Firestore and show them.
const FB_PID = 'stockr-app-65c0e';
const FB_KEY = 'AIzaSyBOgX2B9euy64XMO7gBfHWvWctN74Wt2Tc';

async function fetchLatestPushMessages() {
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PID}/databases/(default)/documents/stockr_push/latest?key=${FB_KEY}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const doc = await r.json();
    const raw = doc?.fields?.d?.stringValue;
    if (!raw) return null;
    const data = JSON.parse(raw);
    // only show messages from the last 20 minutes (avoid replaying stale ones)
    if (Date.now() - (data.ts || 0) > 20 * 60 * 1000) return null;
    return data.messages || null;
  } catch (e) { return null; }
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const msgs = await fetchLatestPushMessages();
    if (msgs && msgs.length) {
      // group into one notification if several fired together
      const title = msgs.length === 1 ? msgs[0].title : `📈 ${msgs.length} price alerts`;
      const body  = msgs.map(m => m.body).join('\n');
      await self.registration.showNotification(title, {
        body, icon: '/icon-192.png', badge: '/icon-192.png',
        tag: 'elaks-price-alert', renotify: true,
        data: { url: '/' }
      });
    } else {
      await self.registration.showNotification('📈 ElaksInsights', {
        body: 'A price alert triggered — tap to view.',
        icon: '/icon-192.png', badge: '/icon-192.png',
        tag: 'elaks-price-alert', renotify: true,
        data: { url: '/' }
      });
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return clients.openWindow('/');
  })());
});
