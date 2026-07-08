/* HelperPay service worker — offline support.
 * Network-first with cache fallback, so updates arrive immediately when
 * online and the app still opens with no connection.
 */
const VERSION = 'helperpay-v4';
const ASSETS = [
  '.',
  'index.html',
  'css/app.css',
  'js/engine.js',
  'js/holidays.js',
  'js/store.js',
  'js/app.js',
  'icon.svg',
  'manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return; // don't cache gov API calls
  e.respondWith(
    // cache: 'no-cache' forces revalidation with the server so updates are
    // never masked by the browser HTTP cache; offline still falls back below.
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
