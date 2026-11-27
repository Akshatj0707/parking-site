/*
 * The service worker: what lets the site be installed as an app and keeps a customer's parking pass working with no signal
 * (a basement car park often has none).
 *
 * WHAT IT KEEPS ON THE PHONE
 *   1. The "shell": the style sheets, scripts and fonts the pass page and the offline page need, so they open offline.
 *      Online, the network always wins (with a short wait); the saved copy is only used when the network fails.
 *   2. Saved passes: the last answer of /api/pass and the QR images of each pass the customer opened, so the pass still shows
 *      with no signal. A saved pass is marked "offline" so the page can say it may be out of date. At most 30 saved files,
 *      none older than 7 days.
 *
 * WHAT IT NEVER TOUCHES
 *   Anything that is not a plain GET on this site: payments, Razorpay (another site), sign-in, accounts, the owner's pages and
 *   every other /api/ address pass straight through and are never saved.
 *
 * The server puts the build into BUILD, so a new release replaces the old shell. Saved passes survive a release.
 */
'use strict';

const BUILD = '{{BUILD_ID}}';
const SHELL = 'bayfind-shell-' + BUILD;
const PASSES = 'bayfind-pass-v1'; // offline.js reads this cache by name too
const MAX_PASS_FILES = 30;
const MAX_PASS_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PASS_WAIT_MS = 4000; // how long a pass waits for the network before the saved copy is shown
const SHELL_WAIT_MS = 3000;

// Needed to open the pass page and the offline page. (test/pwa.test.js checks that every file those two pages load is listed.)
const PRECACHE = [
  '/offline',
  '/css/fonts.css',
  '/css/styles.css',
  '/css/gate.css',
  '/js/shared.js',
  '/js/common.js',
  '/js/pass.js',
  '/js/offline.js',
  '/img/icons.svg',
  '/fonts/dm-sans-latin-400-normal.woff2',
  '/fonts/dm-sans-latin-500-normal.woff2',
  '/fonts/dm-sans-latin-700-normal.woff2',
  '/fonts/bricolage-grotesque-latin-600-normal.woff2',
  '/fonts/bricolage-grotesque-latin-700-normal.woff2',
  '/fonts/bricolage-grotesque-latin-800-normal.woff2',
];
const OPTIONAL = ['/pass']; // the pass page itself; a failure here must not stop the install

const wait = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(PRECACHE);
      await Promise.allSettled(OPTIONAL.map((url) => cache.add(url)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('bayfind-shell-') && name !== SHELL) await caches.delete(name);
      }
      await trimPasses();
      await self.clients.claim();
    })()
  );
});

// Keep the saved passes few and recent.
async function trimPasses() {
  const cache = await caches.open(PASSES);
  const now = Date.now();
  let keys = await cache.keys();
  for (const key of keys) {
    const hit = await cache.match(key);
    const saved = hit && Date.parse(hit.headers.get('date') || '');
    if (Number.isFinite(saved) && now - saved > MAX_PASS_AGE_MS) await cache.delete(key);
  }
  keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PASS_FILES))) await cache.delete(key); // the oldest go first
}

// A saved /api/pass answer is marked, so the page can tell the customer it may be out of date.
async function saved(cache, request) {
  const hit = await cache.match(request);
  if (!hit) return null;
  if (new URL(request.url).pathname !== '/api/pass') return hit;
  try {
    const data = await hit.clone().json();
    return new Response(JSON.stringify({ ...data, offline: true }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return hit;
  }
}

// The network first; the saved copy only when the network fails, is too slow, or the server is broken (5xx).
// A 4xx answer is the real answer (an invalid pass link must not be replaced by an old copy).
async function networkFirst(request, cacheName, waitMs) {
  const cache = await caches.open(cacheName);
  const fetching = fetch(request).then(async (res) => {
    if (res.ok && !res.redirected) {
      await cache.put(request, res.clone());
      if (cacheName === PASSES) await trimPasses();
    }
    return res;
  });
  fetching.catch(() => {}); // a failure after the saved copy was already shown is not an error
  try {
    const res = await wait(fetching, waitMs);
    if (res.status < 500) return res;
    return (await saved(cache, request)) || res;
  } catch (err) {
    return (await saved(cache, request)) || fetching;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

// Opening a page. Only the pass page is kept (its HTML is the same for every pass; the pass token is in the address).
// Every other page needs the network, so offline it is replaced by the offline page.
async function openPage(request) {
  const url = new URL(request.url);
  const shell = await caches.open(SHELL);
  try {
    if (url.pathname === '/pass') {
      const res = await wait(fetch(request), PASS_WAIT_MS);
      if (res.status === 200 && !res.redirected) await shell.put('/pass', res.clone());
      return res;
    }
    return await fetch(request);
  } catch (err) {
    if (url.pathname === '/pass') {
      const page = await shell.match('/pass');
      if (page) return page;
    }
    return (await shell.match('/offline')) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (request.mode === 'navigate') {
    event.respondWith(openPage(request));
  } else if (path === '/api/pass' || path === '/api/pass/qr') {
    event.respondWith(networkFirst(request, PASSES, PASS_WAIT_MS));
  } else if (path.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(request, SHELL));
  } else if (path.startsWith('/css/') || path.startsWith('/js/') || path.startsWith('/img/')) {
    event.respondWith(networkFirst(request, SHELL, SHELL_WAIT_MS));
  }
  // anything else is not answered here: the browser handles it as if there were no service worker
});
