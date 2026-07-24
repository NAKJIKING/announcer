// 아나운서 PWA 서비스 워커
// 전략: HTML·매니페스트는 '네트워크 우선'(수정하면 자동 반영, 오프라인이면 캐시),
//       아이콘 등 정적 리소스는 '캐시 우선'. CACHE 이름을 바꾸면 옛 캐시는 자동 정리.
const CACHE = 'announcer-v1';
const CORE = [
  './',
  'index.html',
  '아나운서.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  const isDoc = req.mode === 'navigate' || req.destination === 'document' ||
                /\.(html|webmanifest|js)(\?|$)/.test(req.url);

  if (isDoc) {
    // 네트워크 우선 → 수정 사항이 즉시 반영됨
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); }
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    );
  } else {
    // 캐시 우선 (아이콘·이미지 등)
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); }
        return res;
      }))
    );
  }
});
