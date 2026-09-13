/* Free web release 20260911-ux-2; atomic offline package. */
const VERSION = 'helperpay-web-20260911-ux-2';
const ASSETS = ["index.html","demo.html","guide.html","privacy.html","icon.svg","manifest.webmanifest","web/20260911-ux-2/analytics.js","web/20260911-ux-2/app.css","web/20260911-ux-2/app.js","web/20260911-ux-2/compliance.js","web/20260911-ux-2/contract-history.js","web/20260911-ux-2/demo-app.js","web/20260911-ux-2/demo-entry.js","web/20260911-ux-2/demo.css","web/20260911-ux-2/engine.js","web/20260911-ux-2/entry.js","web/20260911-ux-2/holiday-review.js","web/20260911-ux-2/holidays.js","web/20260911-ux-2/i18n.js","web/20260911-ux-2/language.js","web/20260911-ux-2/legal-model.js","web/20260911-ux-2/payment-ledger.js","web/20260911-ux-2/store.js","web/20260911-ux-2/web.css"];
// No skipWaiting() on install: with no active worker this one activates by
// itself, and when one IS active, claiming the page would leave it running the
// previous release's calculation rules. It waits until the open page offers a
// reload and sends SKIP_WAITING.
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(url => new Request(url, {cache:'reload'}))))));
self.addEventListener('message', e => { if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
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
