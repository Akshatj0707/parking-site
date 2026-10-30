'use strict';

// The pages and files the browser loads: they exist, their settings are filled in,
// nothing private is served, and the scripts only use ids that the pages really have.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeSite, basic } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const PAGES = { '/': 'index.html', '/book': 'book.html', '/lookup': 'lookup.html', '/dashboard': 'dashboard.html' };
const SCRIPT_FOR = { 'index.html': 'home.js', 'book.html': 'book.js', 'lookup.html': 'lookup.js', 'dashboard.html': 'dashboard.js' };

test('every page is served as HTML with all of its settings filled in', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const url of Object.keys(PAGES)) {
    const res = await site.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /^text\/html/, url);
    assert.doesNotMatch(res.text, /\{\{[A-Z_]+\}\}/, `${url} still has an unfilled {{TOKEN}}`);
    assert.match(res.text, /<title>[^<]*Bayfind/, `${url} has the site name in its title`);
  }
});

test('the home page shows the real rates, bay counts and hold time', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/');
  for (const expected of ['₹40', '₹60', '₹20', '₹30', '200', '250', '450', 'Monday to Friday', 'Saturday and Sunday', '10 minutes']) {
    assert.ok(text.includes(expected), `home page should mention ${expected}`);
  }
  assert.ok(text.includes('1 to 4 hours') || (text.includes('1') && text.includes('4 hours')), 'mentions the length of a booking');
});

test('settings changed in the environment show up on the page', async (t) => {
  const site = await makeSite({ env: { RATE_CAR_WEEKDAY: '55', RATE_BIKE_WEEKEND: '45', WEEKEND_DAYS: '5,6', HOLD_MINUTES: '7', SUPPORT_EMAIL: 'help@example.com' } });
  t.after(() => site.close());
  const { text } = await site.get('/');
  assert.ok(text.includes('₹55'));
  assert.ok(text.includes('₹45'));
  assert.ok(text.includes('Friday and Saturday'), 'weekend days follow WEEKEND_DAYS');
  assert.ok(text.includes('7 minutes'));
  assert.ok(text.includes('mailto:help@example.com'), 'the support email becomes a link');
});

test('the site name is escaped, never trusted as HTML', async (t) => {
  const site = await makeSite({ env: { SITE_NAME: 'Park & Go<b>"' } });
  t.after(() => site.close());
  for (const url of Object.keys(PAGES)) {
    const { text } = await site.get(url);
    assert.ok(text.includes('Park &amp; Go&lt;b&gt;&quot;'), `${url} shows the escaped name`);
    assert.ok(!text.includes('Go<b>'), `${url} must not contain the raw name`);
  }
});

test('the operator dashboard page asks for the password when one is set', async (t) => {
  const site = await makeSite({ env: { OPERATOR_PASSWORD: 'correct horse' } });
  t.after(() => site.close());
  const anon = await site.get('/dashboard');
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /^Basic/);
  assert.ok(!anon.text.includes('Today at the lot'), 'the page itself is not sent');
  const wrong = await site.get('/dashboard', { headers: { authorization: basic('operator', 'nope') } });
  assert.equal(wrong.status, 401);
  const right = await site.get('/dashboard', { headers: { authorization: basic('operator', 'correct horse') } });
  assert.equal(right.status, 200);
  assert.ok(right.text.includes('Today at the lot'));
  // The other pages stay public.
  assert.equal((await site.get('/book')).status, 200);
});

test('only the public folders are served: no source, settings or data', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const private404 = [
    '/index.html', '/book.html', '/lookup.html', '/dashboard.html', '/shared.js',
    '/src/config.js', '/src/bookings.js', '/server.js', '/package.json', '/package-lock.json', '/.env', '/.env.example',
    '/data/bookings.json', '/test/helpers.js', '/node_modules/express/package.json', '/public/index.html', '/README.md',
    '/DEPLOY.md', '/DEPLOY-RENDER.md', '/render.yaml', '/deploy/setup.sh', '/.gitignore',
  ];
  for (const url of private404) {
    const res = await site.get(url);
    assert.equal(res.status, 404, `${url} must not be served`);
  }
  // Folder listings are off, and dot-dot tricks do not escape the public folder.
  assert.equal((await site.get('/css/')).status, 404);
  assert.equal((await site.get('/js')).status, 404);
  assert.equal((await site.get('/css/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await site.get('/css/..%2f..%2fpackage.json')).status, 404);
});

test('stylesheets, scripts, icons and fonts are served with the right types', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const expect = {
    '/css/styles.css': /^text\/css/,
    '/css/fonts.css': /^text\/css/,
    '/js/shared.js': /javascript/,
    '/js/common.js': /javascript/,
    '/js/home.js': /javascript/,
    '/js/book.js': /javascript/,
    '/js/lookup.js': /javascript/,
    '/js/dashboard.js': /javascript/,
    '/img/icons.svg': /^image\/svg\+xml/,
    '/fonts/dm-sans-latin-400-normal.woff2': /woff2/,
    '/fonts/bricolage-grotesque-latin-800-normal.woff2': /woff2/,
    '/favicon.svg': /^image\/svg\+xml/,
  };
  for (const [url, type] of Object.entries(expect)) {
    const res = await site.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), type, url);
  }
  assert.equal((await site.get('/favicon.ico')).status, 204);
});

test('every file a page or stylesheet points at really exists', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const wanted = new Set();
  for (const [url, file] of Object.entries(PAGES)) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) wanted.add(m[1]);
    assert.ok(url);
  }
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'fonts.css'), 'utf8');
  for (const m of css.matchAll(/url\((\/[^)]+)\)/g)) wanted.add(m[1]);
  assert.ok(wanted.size > 20, 'found the references');
  const internalPages = new Set(['/', '/book', '/lookup', '/dashboard', '/favicon.svg']);
  for (const url of wanted) {
    if (internalPages.has(url)) continue;
    const res = await site.get(url);
    assert.equal(res.status, 200, `${url} is referenced but not served`);
  }
  // 12 font files are declared and all of them exist.
  assert.equal([...css.matchAll(/url\(\/fonts\//g)].length, 12);
});

test('pages follow the security rules: no inline scripts or handlers, and a strict policy header', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const [url, file] of Object.entries(PAGES)) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} has an inline script`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file} has an inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${file} has a javascript: link`);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i, `${file} loads a script from another site`);
    const res = await site.get(url);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/\*\.razorpay\.com/);
    assert.match(csp, /frame-src https:\/\/\*\.razorpay\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('the ids that each script looks for exist on its page', () => {
  for (const [page, script] of Object.entries(SCRIPT_FOR)) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const js = fs.readFileSync(path.join(PUBLIC, 'js', script), 'utf8');
    const ids = new Set();
    for (const m of js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
    for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
    assert.ok(ids.size > 0, `${script} looks for some elements`);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `${script} looks for #${id}, which is missing from ${page}`);
  }
  // The home page builds a few ids from the vehicle name: free-car, fill-bike, zones-car and so on.
  const home = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const v of ['car', 'bike']) for (const prefix of ['free', 'fill', 'zones']) assert.ok(home.includes(`id="${prefix}-${v}"`), `home page needs #${prefix}-${v}`);
});

test('unknown pages give a plain not-found, and unknown API paths give JSON', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const page = await site.get('/nope');
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const api = await site.get('/api/nope');
  assert.equal(api.status, 404);
  assert.equal(api.json.error, 'not_found');
});

test('the favicon carries the first letter of the site name', async (t) => {
  const site = await makeSite({ env: { SITE_NAME: 'Zed Parking' } });
  t.after(() => site.close());
  const res = await site.get('/favicon.svg');
  assert.match(res.text, />Z<\/text>/);
});
