'use strict';

// The installable app: the manifest, the icons, and above all the service worker, which is run here against a fake phone
// (a fake cache and a fake network) so that what it saves, what it never saves, and what it shows with no signal are all checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeSite } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const ORIGIN = 'http://lot.test';
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const HTML_ASK = { accept: 'text/html' };

// ===== A fake phone: caches, a network that can be switched off, and the events a browser sends ======================

function phone({ build = 'abc123', network } = {}) {
  const listeners = {};
  const stores = new Map(); // cache name -> Map(url -> Response)
  const calls = [];
  const state = { online: true, delayMs: 0 };

  const urlOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
  const fetchFn = async (req) => {
    const url = urlOf(req);
    calls.push(url);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (!state.online) throw new TypeError('Failed to fetch');
    return network(new URL(url), req);
  };
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      async match(req) {
        const hit = map.get(urlOf(req));
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) {
        map.delete(urlOf(req)); // a saved answer is the newest
        map.set(urlOf(req), res);
      },
      async add(req) {
        const res = await fetchFn({ method: 'GET', url: urlOf(req), mode: 'cors' });
        if (!res.ok) throw new Error('bad status ' + res.status);
        map.set(urlOf(req), res);
      },
      async addAll(list) {
        for (const item of list) await this.add(item);
      },
      async delete(req) {
        return map.delete(urlOf(req));
      },
      async keys() {
        return [...map.keys()].map((url) => ({ url }));
      },
    };
  };
  const caches = {
    open: async (name) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  const self = { addEventListener: (type, fn) => (listeners[type] = fn), location: new URL(ORIGIN), skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const source = SW.replace('{{BUILD_ID}}', build);
  // the real waits are seconds long; here they are milliseconds
  vm.runInNewContext(source, { self, caches, fetch: fetchFn, Response, URL, Date, Promise, JSON, Number, Math, Array, Object, Error, TypeError, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), clearTimeout });

  const req = (p, extra = {}) => ({ method: 'GET', url: ORIGIN + p, mode: 'cors', ...extra });
  const nav = (p) => req(p, { mode: 'navigate' });

  return {
    state,
    calls,
    stores,
    req,
    nav,
    async install() {
      let work;
      listeners.install({ waitUntil: (p) => (work = p) });
      await work;
    },
    async activate() {
      let work;
      listeners.activate({ waitUntil: (p) => (work = p) });
      await work;
    },
    // What the worker does with a request: null when it leaves it alone, otherwise the Response it answers with.
    async ask(request) {
      let answer = null;
      listeners.fetch({ request, respondWith: (p) => (answer = Promise.resolve(p)) });
      return answer;
    },
    async saved(cacheName) {
      return stores.has(cacheName) ? [...stores.get(cacheName).keys()].map((u) => u.replace(ORIGIN, '')) : [];
    },
    allSaved() {
      return [...stores.values()].flatMap((map) => [...map.keys()]);
    },
  };
}

const passJson = (over = {}) => ({ booking: { ref: 'ABC123', plate: 'MP09AB1234', bay: 'A-12' }, gate: { stage: 'ready' }, qr: { in: '/api/pass/qr?t=T&k=in', out: '/api/pass/qr?t=T&k=out' }, serverTime: 1000, ...over });
const jsonRes = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const text = (body, type = 'text/plain', status = 200, headers = {}) => new Response(body, { status, headers: { 'Content-Type': type, ...headers } });

// A server that knows the pass, its QR codes, the pages and the static files.
function server(handlers = {}) {
  return async (url) => {
    const p = url.pathname;
    if (handlers[p]) return handlers[p](url);
    if (p === '/api/pass') return jsonRes(passJson({ booking: { ref: 'ABC123', plate: 'MP09AB1234', bay: 'A-12', token: url.searchParams.get('t') } }));
    if (p === '/api/pass/qr') return text('<svg>qr ' + url.searchParams.get('k') + '</svg>', 'image/svg+xml');
    if (p === '/pass') return text('<html>pass shell</html>', 'text/html');
    if (p === '/offline') return text('<html>offline page</html>', 'text/html');
    if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/img/') || p.startsWith('/fonts/')) return text('file ' + p, 'text/plain');
    return text('<html>page ' + p + '</html>', 'text/html');
  };
}

const bodyOf = (res) => res.text();

// ===== Installing and updating ============================================================================

test('installing saves the files the pass page and the offline page need; a missing pass page does not stop it, a missing file does', async () => {
  const p = phone({ build: 'v1', network: server() });
  await p.install();
  const shell = await p.saved('bayfind-shell-v1');
  for (const need of ['/offline', '/css/styles.css', '/css/gate.css', '/js/pass.js', '/js/offline.js', '/js/common.js', '/pass']) assert.ok(shell.includes(need), need);

  const noPass = phone({ build: 'v1', network: server({ '/pass': () => text('no', 'text/plain', 500) }) });
  await noPass.install();
  assert.ok(!(await noPass.saved('bayfind-shell-v1')).includes('/pass'));

  const broken = phone({ build: 'v1', network: server({ '/js/pass.js': () => text('no', 'text/plain', 404) }) });
  await assert.rejects(broken.install(), 'a release with a missing file is not installed');
});

test('a new release removes the old shell but keeps the passes saved on the phone', async () => {
  const p = phone({ build: 'v2', network: server() });
  await p.ask(p.req('/api/pass?t=T')); // not installed yet, but the worker is already answering
  p.stores.set('bayfind-shell-v1', new Map([[ORIGIN + '/old', text('x')]]));
  p.stores.set('bayfind-shell-v2', new Map());
  p.stores.set('someone-elses-cache', new Map());
  await p.activate();
  const names = [...p.stores.keys()].sort();
  assert.deepEqual(names, ['bayfind-pass-v1', 'bayfind-shell-v2', 'someone-elses-cache']);
  assert.deepEqual(await p.saved('bayfind-pass-v1'), ['/api/pass?t=T']);
});

// ===== What it must never touch ===========================================================================

test('payments, sign-in, accounts, the owner pages and other sites are never answered or saved by the worker', async () => {
  const p = phone({ network: server() });
  await p.install();
  const before = p.allSaved().length;
  const alone = [
    p.req('/api/bookings', { method: 'POST' }),
    p.req('/api/bookings/ABC/pay', { method: 'POST' }),
    p.req('/api/auth/login', { method: 'POST' }),
    p.req('/api/pass/overstay/start?t=T', { method: 'POST' }),
    { method: 'GET', url: 'https://checkout.razorpay.com/v1/checkout.js', mode: 'cors' },
    { method: 'GET', url: 'https://api.razorpay.com/v1/x', mode: 'cors' },
    p.req('/api/dashboard'),
    p.req('/api/dashboard/forecast'),
    p.req('/api/account/bookings'),
    p.req('/api/auth/me'),
    p.req('/api/bookings'),
    p.req('/api/config'),
    p.req('/api/chat'),
    p.req('/favicon.svg'),
    p.req('/manifest.webmanifest'),
    p.req('/sw.js'),
  ];
  for (const r of alone) assert.equal(await p.ask(r), null, `${r.method} ${r.url}`);
  assert.equal(p.allSaved().length, before, 'nothing new was saved');
});

test('private pages are never saved: signed-in pages, invoices, the owner pages, a booking in progress', async () => {
  const p = phone({ network: server() });
  await p.install();
  for (const page of ['/account', '/dashboard', '/analytics', '/invoice?t=SECRET', '/bookings', '/customers', '/officials', '/reset-password?token=SECRET', '/book', '/lookup', '/']) {
    const res = await p.ask(p.nav(page));
    assert.match(await bodyOf(res), /page/, page);
  }
  const saved = p.allSaved().map((u) => u.replace(ORIGIN, ''));
  for (const secret of ['/account', '/dashboard', '/analytics', '/invoice', '/bookings', '/customers', '/officials', '/reset-password', '/book', '/lookup']) assert.ok(!saved.some((u) => u.startsWith(secret)), `${secret} must not be saved`);
  assert.ok(!saved.includes('/'), 'not even the home page');
});

// ===== The pass: online, offline and in between =============================================================

test('an opened pass is saved, and with no signal the saved copy is shown and marked offline', async () => {
  const p = phone({ network: server() });
  await p.install();
  const live = await p.ask(p.req('/api/pass?t=T1'));
  assert.equal(live.status, 200);
  assert.equal((await live.json()).offline, undefined, 'online, the answer is the real one');
  await p.ask(p.req('/api/pass/qr?t=T1&k=in'));
  await p.ask(p.req('/api/pass/qr?t=T1&k=out'));
  assert.deepEqual(await p.saved('bayfind-pass-v1'), ['/api/pass?t=T1', '/api/pass/qr?t=T1&k=in', '/api/pass/qr?t=T1&k=out']);

  p.state.online = false;
  const old = await p.ask(p.req('/api/pass?t=T1'));
  assert.equal(old.status, 200);
  const data = await old.json();
  assert.equal(data.offline, true);
  assert.equal(data.serverTime, 1000, 'the time of the saved copy is kept, so the page can say when it was saved');
  assert.equal(data.booking.ref, 'ABC123');
  const qr = await p.ask(p.req('/api/pass/qr?t=T1&k=in'));
  assert.equal(await qr.text(), '<svg>qr in</svg>');

  // a pass that was never opened on this phone has nothing to show
  await assert.rejects(p.ask(p.req('/api/pass?t=OTHER')));
  await assert.rejects(p.ask(p.req('/api/pass/qr?t=OTHER&k=in')));
});

test('back online, the newest answer wins and replaces the saved one', async () => {
  let stage = 'upcoming';
  const p = phone({ network: server({ '/api/pass': () => jsonRes(passJson({ gate: { stage }, serverTime: stage === 'ready' ? 2000 : 1000 })) }) });
  await p.ask(p.req('/api/pass?t=T1'));
  stage = 'ready';
  assert.equal((await (await p.ask(p.req('/api/pass?t=T1'))).json()).gate.stage, 'ready');
  p.state.online = false;
  const old = await (await p.ask(p.req('/api/pass?t=T1'))).json();
  assert.equal(old.gate.stage, 'ready');
  assert.equal(old.serverTime, 2000);
});

test('a slow network gives way to the saved copy, and a server error does too; a real "no" does not', async () => {
  const p = phone({ network: server() });
  await p.ask(p.req('/api/pass?t=T1')); // saved while the network was fine

  p.state.delayMs = 500; // far slower than the (shortened) wait
  const slow = await (await p.ask(p.req('/api/pass?t=T1'))).json();
  assert.equal(slow.offline, true, 'shown from the saved copy rather than leaving the customer waiting');
  await new Promise((resolve) => setTimeout(resolve, 600)); // the real answer arrives later and is saved
  p.state.delayMs = 0;

  const broken = phone({ network: server({ '/api/pass': () => jsonRes({ error: 'boom' }, 500) }) });
  await broken.ask(broken.req('/api/pass?t=T1')).catch(() => {});
  assert.equal((await broken.ask(broken.req('/api/pass?t=T1'))).status, 500, 'nothing saved: the error shows');

  // a saved copy exists, then the server breaks: the saved copy is shown
  let up = true;
  const q = phone({ network: server({ '/api/pass': () => (up ? jsonRes(passJson()) : jsonRes({ error: 'boom' }, 500)) }) });
  await q.ask(q.req('/api/pass?t=T1'));
  up = false;
  assert.equal((await (await q.ask(q.req('/api/pass?t=T1'))).json()).offline, true);

  // an invalid link is a real answer: it is shown as it is, never replaced by an old copy, and never saved
  let valid = true;
  const r = phone({ network: server({ '/api/pass': () => (valid ? jsonRes(passJson()) : jsonRes({ error: 'not_found' }, 404)) }) });
  await r.ask(r.req('/api/pass?t=T1'));
  valid = false;
  assert.equal((await r.ask(r.req('/api/pass?t=T1'))).status, 404);
  const none = await r.ask(r.req('/api/pass?t=BAD'));
  assert.equal(none.status, 404);
  assert.ok(!(await r.saved('bayfind-pass-v1')).includes('/api/pass?t=BAD'));
});

test('only 30 saved pass files are kept, and nothing older than 7 days', async () => {
  const p = phone({ network: server() });
  for (let i = 0; i < 40; i++) await p.ask(p.req('/api/pass?t=T' + i));
  const kept = await p.saved('bayfind-pass-v1');
  assert.equal(kept.length, 30);
  assert.ok(kept.includes('/api/pass?t=T39'), 'the newest are kept');
  assert.ok(!kept.includes('/api/pass?t=T0'), 'the oldest go first');

  const stale = phone({ network: server() });
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toUTCString();
  stale.stores.set('bayfind-pass-v1', new Map([[ORIGIN + '/api/pass?t=OLD', jsonRes(passJson(), 200, { Date: old })]]));
  await stale.ask(stale.req('/api/pass?t=NEW'));
  assert.deepEqual(await stale.saved('bayfind-pass-v1'), ['/api/pass?t=NEW'], 'a copy from 10 days ago is dropped');
  await stale.activate();
  assert.deepEqual(await stale.saved('bayfind-pass-v1'), ['/api/pass?t=NEW']);
});

// ===== Pages and files ====================================================================================

test('the pass page opens with no signal; any other page shows the offline page', async () => {
  const p = phone({ network: server() });
  await p.install();
  await p.ask(p.nav('/pass?t=T1')); // opened once while online
  p.state.online = false;
  assert.equal(await bodyOf(await p.ask(p.nav('/pass?t=T1'))), '<html>pass shell</html>');
  assert.equal(await bodyOf(await p.ask(p.nav('/pass?t=T2'))), '<html>pass shell</html>', 'the page is the same for every pass; the token is in the address');
  for (const page of ['/book', '/account', '/dashboard', '/invoice?t=T1', '/']) assert.equal(await bodyOf(await p.ask(p.nav(page))), '<html>offline page</html>', page);

  const fresh = phone({ network: server({ '/pass': () => text('no', 'text/plain', 500) }) });
  await fresh.install();
  fresh.state.online = false;
  assert.equal(await bodyOf(await fresh.ask(fresh.nav('/pass?t=T1'))), '<html>offline page</html>', 'nothing saved yet: the offline page lists what is saved');
});

test('the pass page is saved only when it loaded properly', async () => {
  let status = 200;
  const p = phone({ network: server({ '/pass': () => text('<html>shell ' + status + '</html>', 'text/html', status) }) });
  await p.install();
  status = 500;
  await p.ask(p.nav('/pass?t=T1'));
  p.state.online = false;
  assert.equal(await bodyOf(await p.ask(p.nav('/pass?t=T1'))), '<html>shell 200</html>', 'the error page was not saved over the good one');
});

test('style sheets and scripts come from the network when there is one, and from the phone when there is none', async () => {
  let version = 'one';
  const p = phone({ network: server({ '/css/styles.css': () => text('css ' + version) }) });
  await p.install();
  version = 'two';
  assert.equal(await bodyOf(await p.ask(p.req('/css/styles.css'))), 'css two', 'a release is seen at once, never an old copy');
  p.state.online = false;
  assert.equal(await bodyOf(await p.ask(p.req('/css/styles.css'))), 'css two');
  assert.equal(await bodyOf(await p.ask(p.req('/js/pass.js'))), 'file /js/pass.js');
});

test('fonts are kept and not fetched again', async () => {
  const p = phone({ network: server() });
  await p.ask(p.req('/fonts/dm-sans-latin-400-normal.woff2'));
  const n = p.calls.length;
  await p.ask(p.req('/fonts/dm-sans-latin-400-normal.woff2'));
  assert.equal(p.calls.length, n);
});

// ===== The website side ===================================================================================

test('the manifest names the app, starts at the home page and has icons that exist at the sizes it says', async (t) => {
  const s = await makeSite({ env: { SITE_NAME: 'Bayfind Parking Indore' } });
  t.after(() => s.close());
  const r = await s.get('/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/manifest\+json/);
  const m = JSON.parse(r.text);
  assert.equal(m.name, 'Bayfind Parking Indore');
  assert.equal(m.short_name, 'Bayfind Park', 'at most 12 characters under an icon');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(m.shortcuts.every((x) => x.url.startsWith('/')));
  const sizes = m.icons.map((i) => i.sizes + ' ' + i.purpose).sort();
  assert.deepEqual(sizes, ['192x192 any', '512x512 any', '512x512 maskable']);
  for (const icon of [...m.icons, { src: '/img/apple-touch-icon.png', sizes: '180x180' }]) {
    const file = fs.readFileSync(path.join(PUBLIC, icon.src.replace(/^\//, '')));
    assert.equal(file.subarray(1, 4).toString(), 'PNG', icon.src);
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual([file.readUInt32BE(16), file.readUInt32BE(20)], [w, h], icon.src);
    const served = await s.get(icon.src);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
  }
});

test('the service worker is served from the root, never cached by the browser, with this release in its name', async (t) => {
  const before = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = 'abc1234def5678';
  const s = await makeSite({});
  if (before === undefined) delete process.env.RENDER_GIT_COMMIT;
  else process.env.RENDER_GIT_COMMIT = before;
  t.after(() => s.close());
  const r = await s.get('/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('service-worker-allowed'), '/');
  assert.doesNotMatch(r.text, /\{\{/);
  assert.match(r.text, /const BUILD = 'abc1234def56';/);
});

test('every page links the manifest and the Apple icon, and registers the worker through common.js', async (t) => {
  const s = await makeSite({});
  t.after(() => s.close());
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, file);
    assert.match(html, /<link rel="apple-touch-icon" href="\/img\/apple-touch-icon\.png">/, file);
  }
  for (const page of ['/', '/book', '/pass', '/offline', '/terms', '/login']) {
    const r = await s.get(page, { headers: HTML_ASK });
    assert.equal(r.status, 200, page);
    assert.match(r.text, /rel="manifest"/, page);
    assert.doesNotMatch(r.text, /\{\{/, page);
  }
  const common = fs.readFileSync(path.join(PUBLIC, 'js', 'common.js'), 'utf8');
  assert.match(common, /serviceWorker\.register\('\/sw\.js'\)/);
});

test('the worker saves every file the pass page and the offline page load, so both open with no signal', () => {
  const need = new Set();
  for (const file of ['pass.html', 'offline.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const m of html.matchAll(/<(?:link rel="(?:stylesheet|preload)"|script)\b[^>]*?(?:href|src)="(\/[^"]+)"/g)) {
      if (/^\/(css|js|fonts|img)\//.test(m[1])) need.add(m[1]);
    }
  }
  need.add('/offline');
  need.add('/img/icons.svg'); // the icon sprite is loaded by common.js
  // the fonts the style sheet can ask for (the Latin ones; the extended sets are only fetched for other alphabets)
  const fonts = fs.readFileSync(path.join(PUBLIC, 'css', 'fonts.css'), 'utf8');
  for (const m of fonts.matchAll(/url\((\/fonts\/[^)]+)\)/g)) if (!m[1].includes('-latin-ext-')) need.add(m[1]);
  const listed = new Set([...SW.matchAll(/^\s+'(\/[^']+)',$/gm)].map((m) => m[1]));
  for (const f of need) assert.ok(listed.has(f), `${f} is not in the worker's list`);
  for (const f of listed) {
    if (f === '/offline') continue;
    assert.ok(fs.existsSync(path.join(PUBLIC, f.replace(/^\//, ''))), `${f} is listed but does not exist`);
  }
});

test('the offline page and the worker use the same name for the saved passes', () => {
  const name = /const PASSES = '([^']+)'/.exec(SW)[1];
  const page = fs.readFileSync(path.join(PUBLIC, 'js', 'offline.js'), 'utf8');
  assert.match(page, new RegExp(`const PASSES = '${name}'`));
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|document\.write/, 'saved data goes on the page as text');
});

test('the offline page and the pass page tell the customer when they are looking at a saved copy', async (t) => {
  const s = await makeSite({});
  t.after(() => s.close());
  const r = await s.get('/offline', { headers: HTML_ASK });
  assert.match(r.text, /You are offline/);
  assert.match(r.text, /id="saved"/);
  const pass = fs.readFileSync(path.join(PUBLIC, 'js', 'pass.js'), 'utf8');
  assert.match(pass, /info\.offline/);
  assert.match(pass, /You are offline\. This is the copy of your pass saved at/);
  assert.match(pass, /if \(!info\.offline\) offset =/, "a saved copy's old server time must not move the clock");
  assert.match((await s.get('/privacy', { headers: HTML_ASK })).text, /saves a copy of each pass you open/);
});

// replaceChildren(x, cond ? y : null) writes the word "null" on the page; the h() helper skips nulls, the browser's own method does not.
test('no page script hands a possibly-null value straight to replaceChildren or append', () => {
  const offenders = [];
  const dir = path.join(PUBLIC, 'js');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/\b(?:replaceChildren|\.append|\.prepend)\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      let arg = '';
      const args = [];
      let quote = null;
      for (; i < src.length && depth > 0; i++) {
        const c = src[i];
        if (quote) {
          arg += c;
          if (c === '\\') arg += src[++i];
          else if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c)) depth--;
        if (depth === 0) break;
        if (c === ',' && depth === 1) {
          args.push(arg);
          arg = '';
          continue;
        }
        arg += c;
      }
      args.push(arg);
      for (const a of args) if (/\?[\s\S]*:\s*null\s*$/.test(a.trim()) && !/^\s*\.\.\./.test(a)) offenders.push(`${file}: ${a.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
