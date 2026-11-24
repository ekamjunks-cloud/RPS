// RPS 10 service worker: makes the game installable and quick to open.
// Pages are fetched fresh when online (so new versions show up right away) and come from the cache offline.
// Built files have unique names per version, so they are cached for good. The game server is never cached.
const CACHE = 'rps10-v1';
const CORE = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const save = (req, res) => { if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res)).catch(() => {}); };
const cacheFirst = req => caches.match(req).then(hit => hit || fetch(req).then(res => { save(req, res.clone()); return res; }));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(cacheFirst(req));
    return; // the game server and sign-in always go straight to the network
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then(res => { save('./', res.clone()); return res; })
      .catch(() => caches.match('./')));
    return;
  }
  if (url.pathname.includes('/assets/')) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => { save(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
