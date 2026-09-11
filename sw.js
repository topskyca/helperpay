/* Free web release 20260911-free-1; atomic offline package. */
const VERSION = 'helperpay-web-20260911-free-1';
const ASSETS = ["index.html","demo.html","guide.html","privacy.html","icon.svg","manifest.webmanifest","web/20260911-free-1/analytics.js","web/20260911-free-1/app.css","web/20260911-free-1/app.js","web/20260911-free-1/compliance.js","web/20260911-free-1/demo-app.js","web/20260911-free-1/demo-entry.js","web/20260911-free-1/demo.css","web/20260911-free-1/engine.js","web/20260911-free-1/entry.js","web/20260911-free-1/holidays.js","web/20260911-free-1/i18n.js","web/20260911-free-1/legal-model.js","web/20260911-free-1/store.js","web/20260911-free-1/web.css"];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(url => new Request(url, {cache:'reload'})))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// Old package caches are deliberately retained so already-open tabs can finish
// safely. Browser storage eviction may remove them; no user records are cached.
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url), scope = new URL(self.registration.scope);
  if(url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length) || 'index.html';
  if(!ASSETS.includes(path)) return;
  e.respondWith(caches.open(VERSION).then(async c => (await c.match(new URL(path, scope).href)) || fetch(e.request)));
});
