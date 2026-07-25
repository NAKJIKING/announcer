// 아나운서 서비스 워커 v3 — 강제 갱신판
// 이전 버전이 옛 화면을 캐시에 붙잡고 있던 문제를 해결하기 위해,
// 설치 즉시 모든 옛 캐시를 삭제하고, HTML/JS는 항상 네트워크에서 받는다.
const CACHE = 'announcer-v3';

self.addEventListener('install', () => {
  self.skipWaiting();   // 기다리지 않고 즉시 새 워커로 교체
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 이름과 무관하게 이 오리진의 모든 캐시 삭제 (옛 화면 완전 제거)
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
    // 열려 있는 창을 새로고침해서 즉시 새 화면으로
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) { try { c.navigate(c.url); } catch (_) {} }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  const isDoc = req.mode === 'navigate' || req.destination === 'document' ||
                /\.(html|webmanifest|js)(\?|$)/.test(req.url);

  if (isDoc) {
    // HTML/매니페스트/JS: 항상 네트워크 최신본 (캐시에 저장하지 않음)
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
  } else {
    // 아이콘 등 정적 파일만 캐시 활용
    e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) { const c2 = res.clone(); caches.open(CACHE).then((c) => c.put(req, c2)); }
      return res;
    })));
  }
});
