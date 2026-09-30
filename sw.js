// アプリ本体だけをキャッシュ（予定データは app.js が localStorage に保存）
const CACHE = 'techo-v4';
const FILES = ['./', './index.html', './style.css', './js/app.js', './js/logic.js', './js/print.js',
  './js/backend-google.js', './js/backend-demo.js', './js/obsidian.js', './js/obsidian-md.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 自サイトのファイルは「ネット優先・失敗したらキャッシュ」（更新がすぐ反映されるように）
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
