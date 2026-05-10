const CACHE = 'stockr-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['./', './sw.js', './manifest.json']))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only cache same-origin requests (not API calls to anthropic/finnhub/firebase)
  if (!e.request.url.startsWith(self.location.origin)) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.open(CACHE).then(c =>
      c.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.status === 200) c.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
