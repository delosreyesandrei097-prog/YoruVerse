/**
 * YoruVerse Service Worker
 * Multi-cache strategy for fast repeat loads + low Firestore/CDN usage.
 *
 *  - STATIC_CACHE : versioned shell (CSS/JS/icons). Stale-while-revalidate.
 *  - PAGES_CACHE  : HTML documents. Network-first w/ cache fallback.
 *  - IMAGES_CACHE : covers/thumbnails/chapter pages. Cache-first, LRU-capped.
 *                   Firebase Storage URLs are immutable (signed token), so
 *                   we never revalidate them in the background -> zero waste.
 */

const VERSION       = 'v12';
const STATIC_CACHE  = `yoruverse-static-${VERSION}`;
const PAGES_CACHE   = `yoruverse-pages-${VERSION}`;
const IMAGES_CACHE  = `yoruverse-images-${VERSION}`;
const IMAGE_CACHE_LIMIT = 400; // ~400 covers/pages on device

const STATIC_ASSETS = [
  '/',
  '/css/variables.css',
  '/css/reset.css',
  '/css/main.css',
  '/css/exp.css',
  '/css/donation.css',
  '/js/firebase-config.js',
  '/js/auth.js',
  '/js/db.js',
  '/js/ui.js',
  '/js/comments.js',
  '/js/exp-system.js',
  '/js/donation.js',
  '/js/import-tool.js',
  '/js/source-registry.js',
  '/sources/source-template.js',
  '/sources/source-example.js',
  '/images/placeholder.png',
  '/images/default-avatar.png',
  '/images/favicon.png',
  '/images/Y.png',
  '/images/O.png',
  '/404.html'
];

// ---------- install / activate ----------

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(err => console.log('[SW] precache error:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  const keep = new Set([STATIC_CACHE, PAGES_CACHE, IMAGES_CACHE]);
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// ---------- helpers ----------

function isImageRequest(req, url) {
  if (req.destination === 'image') return true;
  return /\.(?:png|jpe?g|webp|gif|avif|svg|ico)(?:\?|$)/i.test(url.pathname);
}

function isHTMLRequest(req) {
  return req.mode === 'navigate' ||
    (req.destination === 'document') ||
    (req.headers.get('accept') || '').includes('text/html');
}

function isStaticAsset(url) {
  return /\.(?:css|js|woff2?|ttf|otf)(?:\?|$)/i.test(url.pathname);
}

// LRU-ish cap: drop oldest entries when cache exceeds limit.
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length <= maxEntries) return;
  const overflow = keys.length - maxEntries;
  for (let i = 0; i < overflow; i++) {
    await cache.delete(keys[i]);
  }
}

// ---------- fetch ----------

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept Firestore/Auth/Realtime APIs - they need live data.
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') && !url.hostname.includes('storage.googleapis.com')) {
    return;
  }

  // 1) Images -> cache-first + LRU. Firebase Storage URLs are immutable.
  if (isImageRequest(req, url)) {
    event.respondWith(handleImage(req));
    return;
  }

  // 2) HTML documents -> network-first so updates ship immediately,
  //    cache fallback so offline / flaky networks still render.
  if (isHTMLRequest(req)) {
    event.respondWith(handleDocument(req));
    return;
  }

  // 3) CSS/JS/fonts -> stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(handleStatic(req));
    return;
  }

  // 4) Everything else -> try cache, fall back to network.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).catch(() => cached))
  );
});

async function handleImage(req) {
  const cache  = await caches.open(IMAGES_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    // Cache successful image responses (including opaque from cross-origin CDNs).
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).then(() => trimCache(IMAGES_CACHE, IMAGE_CACHE_LIMIT));
    }
    return res;
  } catch (_) {
    // Last-resort fallback so layout doesn't break.
    return caches.match('/images/placeholder.png');
  }
}

async function handleDocument(req) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return caches.match('/404.html');
  }
}

async function handleStatic(req) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}

// ============================================================
// Periodic Background Sync bridge (round 4) - unchanged
// ============================================================
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'mp-register-periodic-sync') {
    const minMinutes = Math.max(5, Number(data.intervalMinutes) || 60);
    const minInterval = minMinutes * 60 * 1000;
    if (self.registration && 'periodicSync' in self.registration) {
      self.registration.periodicSync.register('mp-series-sync', { minInterval })
        .catch(err => console.log('[SW] periodicSync register skipped:', err && err.message));
    }
  }
});

self.addEventListener('periodicsync', event => {
  if (event.tag !== 'mp-series-sync') return;
  event.waitUntil(notifyClientsToSync());
});

async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  if (!clients.length) return;
  for (const c of clients) {
    try { c.postMessage({ type: 'mp-run-sync-all', source: 'periodicSync' }); } catch (_) {}
  }
}
