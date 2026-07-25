// 아나운서 PWA 서비스 워커
// HTML/매니페스트/JS는 '네트워크 우선' → 수정하면 즉시 반영. 아이콘은 캐시 우선.
const CACHE = 'announcer-v2';
const CORE = ['./', 'index.html', 'app.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE))
    .then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isDoc = req.mode === 'navigate' || req.destination === 'document' ||
                /\.(html|webmanifest|js)(\?|$)/.test(req.url);
  if (isDoc) {
    e.respondWith(fetch(req).then((res) => {
      if (res && res.ok) { const c2 = res.clone(); caches.open(CACHE).then((c) => c.put(req, c2)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) { const c2 = res.clone(); caches.open(CACHE).then((c) => c.put(req, c2)); }
      return res;
    })));
  }
});
