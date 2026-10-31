'use strict';

// Hosting on Render (render.com): the settings the site chooses by itself there, the dashboard's setup check, and the
// render.yaml file that tells Render how to run the site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, RENDER_DISK_PATH } = require('../src/config');
const { makeSite, basic, KEY_SECRET, WEBHOOK_SECRET } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ===== Settings that choose themselves on Render ==================================================

test('on Render the site picks one proxy and a bookings folder on the disk by itself', () => {
  const testing = loadConfig({ RENDER: 'true', NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' });
  assert.equal(testing.onRender, true);
  assert.equal(testing.trustProxy, 1);
  assert.equal(testing.host, '0.0.0.0');
  assert.equal(testing.dataDir, path.resolve(RENDER_DISK_PATH, 'test'));
  assert.equal(testing.dataOnRenderDisk, true);

  // Switching to live keys moves the site to a fresh folder, so test bookings never mix with real ones.
  const live = loadConfig({ RENDER: 'true', NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's' });
  assert.equal(live.dataDir, path.resolve(RENDER_DISK_PATH, 'live'));
  assert.equal(live.dataOnRenderDisk, true);

  // Without any keys (the first minutes after the site is created) it is the test folder too.
  assert.equal(loadConfig({ RENDER: 'true' }).dataDir, path.resolve(RENDER_DISK_PATH, 'test'));
});

test('on Render, anything that is filled in wins over those choices', () => {
  const c = loadConfig({ RENDER: 'true', TRUST_PROXY: '2', DATA_DIR: '/var/data/custom', HOST: '127.0.0.1' });
  assert.equal(c.trustProxy, 2);
  assert.equal(c.dataDir, path.resolve('/var/data/custom'));
  assert.equal(c.host, '127.0.0.1');
  assert.equal(loadConfig({ RENDER: 'true', TRUST_PROXY: '0' }).trustProxy, 0, '0 is a choice, not "empty"');
  assert.equal(loadConfig({ RENDER: 'true', TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(loadConfig({ RENDER: 'true', TRUST_PROXY: '   ' }).trustProxy, 1, 'blank spaces count as empty');
  assert.equal(loadConfig({ RENDER: 'true', DATA_DIR: '' }).dataDir, path.resolve(RENDER_DISK_PATH, 'test'), 'an empty setting counts as empty');
});

test('anywhere else nothing changes', () => {
  const c = loadConfig({});
  assert.equal(c.onRender, false);
  assert.equal(c.trustProxy, false);
  assert.equal(c.dataOnRenderDisk, null);
  assert.equal(c.dataDir, path.resolve(__dirname, '..', 'data'));
  assert.equal(loadConfig({ NODE_ENV: 'production' }).trustProxy, false);
  assert.equal(loadConfig({ RENDER: 'false' }).onRender, false);
  assert.equal(loadConfig({ RENDER: '' }).onRender, false);
  assert.equal(loadConfig({ RENDER: '1' }).onRender, true);
  assert.equal(loadConfig({ TRUST_PROXY: ' 1 ' }).trustProxy, 1, 'spaces around the number are ignored everywhere');
});

test('a bookings folder that is not on the disk is noticed', () => {
  assert.equal(loadConfig({ RENDER: 'true', DATA_DIR: '/var/data' }).dataOnRenderDisk, true);
  assert.equal(loadConfig({ RENDER: 'true', DATA_DIR: '/var/data/live' }).dataOnRenderDisk, true);
  assert.equal(loadConfig({ RENDER: 'true', DATA_DIR: '/opt/render/project/src/data' }).dataOnRenderDisk, false);
  assert.equal(loadConfig({ RENDER: 'true', DATA_DIR: '/var/database' }).dataOnRenderDisk, false, 'a name that only starts the same is not inside');
  assert.equal(loadConfig({ RENDER: 'true', DATA_DIR: '/var/data/../elsewhere' }).dataOnRenderDisk, false);
});

// ===== The dashboard's setup check ==========================================================================

const CHECK = '/api/dashboard/connection';
const good = { authorization: basic('operator', 'correct horse') };
// What a proxy chain in front of the site looks like: the visitor, then one more proxy, then the platform's own server.
const FORWARDED = { 'x-forwarded-for': '203.0.113.7, 172.70.1.2', 'x-forwarded-proto': 'https' };

async function site(t, options = {}) {
  const s = await makeSite({ ...options, env: { OPERATOR_PASSWORD: 'correct horse', ...(options.env || {}) } });
  t.after(() => s.close());
  return s;
}

test('the setup check shows what each TRUST_PROXY number would give, and Express agrees with every row', async (t) => {
  for (const n of [0, 1, 2, 3]) {
    const s = await site(t, { env: { TRUST_PROXY: String(n) } });
    const r = await s.get(CHECK, { headers: { ...good, ...FORWARDED } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.options, [
      { trust: 0, address: '127.0.0.1' },
      { trust: 1, address: '172.70.1.2' },
      { trust: 2, address: '203.0.113.7' },
    ]);
    assert.equal(r.json.connection, '127.0.0.1');
    assert.equal(r.json.forwardedFor, '203.0.113.7, 172.70.1.2');
    assert.equal(r.json.trustProxy, n);
    // The address the site really uses (what Express worked out) is the row for the number that is set.
    assert.equal(r.json.address, r.json.options[Math.min(n, 2)].address, `with TRUST_PROXY=${n}`);
    // The forwarded protocol only counts once a proxy is trusted.
    assert.equal(r.json.secure, n >= 1, `with TRUST_PROXY=${n}`);
    assert.equal(r.json.forwardedProto, 'https');
  }
});

test('with no TRUST_PROXY the site sees only the machine that connected', async (t) => {
  const s = await site(t);
  const r = await s.get(CHECK, { headers: { ...good, ...FORWARDED } });
  assert.equal(r.json.trustProxy, null);
  assert.equal(r.json.address, '127.0.0.1');
  assert.equal(r.json.secure, false);
});

test('a request with no forwarded address has just the one row', async (t) => {
  const s = await site(t, { env: { TRUST_PROXY: '1' } });
  const r = await s.get(CHECK, { headers: good });
  assert.deepEqual(r.json.options, [{ trust: 0, address: '127.0.0.1' }]);
  assert.equal(r.json.forwardedFor, null);
  assert.equal(r.json.forwardedProto, null);
  assert.equal(r.json.address, '127.0.0.1');
});

test('the setup check copes with a messy or very long forwarded list', async (t) => {
  const s = await site(t, { env: { TRUST_PROXY: '1' } });
  const many = Array.from({ length: 30 }, (_, i) => `198.51.100.${i + 1}`).join(',');
  const r = await s.get(CHECK, { headers: { ...good, 'x-forwarded-for': many } });
  assert.equal(r.status, 200);
  assert.ok(r.json.options.length <= 8, 'the table stays short');
  assert.equal(r.json.options[1].address, '198.51.100.30', 'rows start from the proxy nearest the site');
  const odd = await s.get(CHECK, { headers: { ...good, 'x-forwarded-for': ' , 203.0.113.7 ,, ' + 'x'.repeat(300) } });
  assert.equal(odd.status, 200);
  assert.ok(odd.json.options.every((o) => o.address.length <= 100), 'nothing long is echoed back');
});

test('the setup check is for the operator only, and it shows no secrets', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  for (const headers of [{}, { authorization: basic('operator', 'nope') }]) {
    const r = await s.get(CHECK, { headers });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /^Basic/);
  }
  const ok = await s.get(CHECK, { headers: good });
  assert.equal(ok.status, 200);
  for (const secret of [KEY_SECRET, WEBHOOK_SECRET, 'correct horse', 'rzp_test']) {
    assert.ok(!ok.text.includes(secret), `the check must not show ${secret}`);
  }
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  const production = await makeSite({ razorpayKeys: true, env: { NODE_ENV: 'production' } });
  t.after(() => production.close());
  assert.equal((await production.get(CHECK)).status, 503, 'in production it stays off until a password is set');
});

test('the setup check says where bookings are saved and whether that is on the Render disk', async (t) => {
  // makeSite keeps the real bookings in a temporary folder, so naming a folder on the disk here writes nothing there.
  const onDisk = await site(t, { env: { RENDER: 'true', DATA_DIR: '/var/data/live' } });
  const a = (await onDisk.get(CHECK, { headers: good })).json;
  assert.deepEqual({ ...a.storage, bookings: undefined }, { folder: path.resolve('/var/data/live'), onRender: true, onDisk: true, diskPath: '/var/data', bookings: undefined });
  assert.equal(a.storage.bookings, 0);

  const off = await site(t, { env: { RENDER: 'true' } }); // makeSite's temporary folder is not on the disk
  const b = (await off.get(CHECK, { headers: good })).json;
  assert.equal(b.storage.onRender, true);
  assert.equal(b.storage.onDisk, false);

  const elsewhere = await site(t);
  const c = (await elsewhere.get(CHECK, { headers: good })).json;
  assert.equal(c.storage.onRender, false);
  assert.equal(c.storage.onDisk, null);
  assert.equal(c.storage.diskPath, null);
  assert.equal(typeof c.uptimeSeconds, 'number');
  assert.equal(c.node, process.version);
});

test('the setup check counts the bookings in the file', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  assert.equal((await s.get(CHECK, { headers: good })).json.storage.bookings, 0);
  const made = await s.post('/api/bookings', { vehicle: 'car', zone: 0, plate: 'MP09AB1234', date: '2026-10-14', time: '11:00', hours: 2 });
  assert.equal(made.status, 201, made.text);
  assert.equal((await s.get(CHECK, { headers: good })).json.storage.bookings, 1);
});

test('the dashboard page has the setup check panel', async (t) => {
  const s = await site(t);
  const page = await s.get('/dashboard', { headers: good });
  assert.equal(page.status, 200);
  for (const id of ['check-panel', 'check-go', 'check-results']) assert.ok(page.text.includes(`id="${id}"`), `${id} is on the page`);
});

// ===== render.yaml =========================================================================================

// A very small reader for the plain YAML that render.yaml uses: nested maps, lists of maps, "key: value" lines, quotes
// and comments. (Node has no YAML reader built in, and this site needs no other packages.)
function readYaml(text, name = 'render.yaml') {
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    rows.push({ indent: line.length - line.trimStart().length, text: line.trim().replace(/\s+#.*$/, '') });
  }
  let at = 0;
  const scalar = (s) => {
    if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  };
  function block(indent) {
    if (rows[at].text.startsWith('- ')) {
      const list = [];
      while (at < rows.length && rows[at].indent === indent && rows[at].text.startsWith('- ')) {
        // "- key: value" is a map whose first line sits two columns further in
        rows[at] = { indent: indent + 2, text: rows[at].text.slice(2).trim() };
        list.push(block(indent + 2));
      }
      return list;
    }
    const map = {};
    while (at < rows.length && rows[at].indent === indent && !rows[at].text.startsWith('- ')) {
      const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(rows[at].text);
      assert.ok(m, `${name} has a line this test does not understand: ${rows[at].text}`);
      at += 1;
      if (m[2] !== '') map[m[1]] = scalar(m[2]);
      else if (at < rows.length && rows[at].indent > indent) map[m[1]] = block(rows[at].indent);
      else map[m[1]] = null;
    }
    return map;
  }
  const result = block(rows[0].indent);
  assert.equal(at, rows.length, `${name} was not read to the end`);
  return result;
}

const blueprint = () => readYaml(read('render.yaml'));

test('render.yaml describes one web service that this site can really run as', () => {
  const doc = blueprint();
  assert.equal(doc.services.length, 1);
  const svc = doc.services[0];
  const pkg = JSON.parse(read('package.json'));

  assert.equal(svc.type, 'web');
  assert.equal(svc.runtime, 'node');
  assert.equal(svc.startCommand, 'npm start');
  assert.ok(pkg.scripts.start, 'package.json has the start command');
  assert.match(svc.buildCommand, /^npm ci\b/);
  assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')), 'npm ci needs the lock file');
  assert.equal(svc.healthCheckPath, '/healthz');
  assert.notEqual(svc.plan, 'free', 'the free size keeps no files, so it cannot hold bookings');
  assert.equal(svc.autoDeployTrigger, 'off', 'an update goes live only when the owner presses Deploy');
});

test('the health check address answers quickly with a plain OK', async (t) => {
  const s = await site(t);
  const r = await s.get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('render.yaml mounts the disk where the site saves its bookings', () => {
  const { disk } = blueprint().services[0];
  assert.equal(disk.mountPath, RENDER_DISK_PATH);
  assert.ok(disk.sizeGB >= 1);
  assert.ok(disk.name);
  // Render refuses these folders for a disk.
  const refused = ['/', '/opt', '/opt/render', '/opt/render/project', '/opt/render/project/src', '/home', '/home/render', '/etc', '/etc/secrets'];
  assert.ok(!refused.includes(disk.mountPath));
});

test('render.yaml keeps secrets out of the file and leaves the self-chosen settings out', () => {
  const text = read('render.yaml');
  assert.doesNotMatch(text, /rzp_(test|live)_[A-Za-z0-9]{6,}/, 'no Razorpay key in the file');
  const vars = Object.fromEntries(blueprint().services[0].envVars.map((v) => [v.key, v]));

  assert.equal(vars.NODE_ENV.value, 'production');
  const [major, minor] = String(vars.NODE_VERSION.value).split('.').map(Number);
  assert.ok(major > 20 || (major === 20 && minor >= 12), 'a Node version this site accepts');

  for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'OPERATOR_PASSWORD']) {
    assert.equal(vars[key].sync, false, `${key} is typed into Render, not kept in this file`);
    assert.equal('value' in vars[key], false);
  }
  // Each setting has either a fixed value or a box in Render's form, never both and never neither.
  for (const v of Object.values(vars)) assert.equal('value' in v, v.sync !== false, `${v.key} has a value or a form box`);

  // Left to the site on Render (src/config.js), so a typing slip cannot lose bookings or mix test and live ones.
  for (const key of ['DATA_DIR', 'TRUST_PROXY', 'PORT', 'HOST']) assert.ok(!(key in vars), `${key} is chosen by the site on Render`);
});

test('every setting in render.yaml is one the site reads, and is in .env.example', () => {
  const code = read('src/config.js');
  const example = read('.env.example');
  for (const { key } of blueprint().services[0].envVars) {
    if (key === 'NODE_VERSION') continue; // read by Render itself
    assert.ok(code.includes(`env.${key}`), `src/config.js reads ${key}`);
    assert.ok(new RegExp(`^#?\\s*${key}=`, 'm').test(example), `.env.example describes ${key}`);
  }
});

test('the files Render builds from leave out secrets and local data', () => {
  const ignored = read('.gitignore').split('\n').map((l) => l.trim());
  for (const entry of ['.env', 'node_modules/', 'data/']) assert.ok(ignored.includes(entry), `.gitignore lists ${entry}`);
});

test('the Render guide mentions every box Render asks for', () => {
  const guide = read('DEPLOY-RENDER.md');
  for (const { key, sync } of blueprint().services[0].envVars) {
    if (sync === false) assert.ok(guide.includes(key), `DEPLOY-RENDER.md explains ${key}`);
  }
  for (const word of ['render.yaml', '/var/data', 'TRUST_PROXY', 'Setup check', '/api/razorpay/webhook']) assert.ok(guide.includes(word), `the guide mentions ${word}`);
});

// ===== render-free.yaml: the free demo =====================================================================

const freeBlueprint = () => readYaml(read('render-free.yaml'), 'render-free.yaml');
const varsOf = (doc) => Object.fromEntries(doc.services[0].envVars.map((v) => [v.key, v]));

test('render-free.yaml runs the same site on Render\'s free size, with no disk', () => {
  const doc = freeBlueprint();
  assert.equal(doc.services.length, 1);
  const free = doc.services[0];
  const paid = blueprint().services[0];

  assert.equal(free.plan, 'free');
  assert.ok(!('disk' in free), 'the free size cannot have a disk');
  // How the site is built, started and checked is the same as in render.yaml.
  for (const key of ['type', 'runtime', 'buildCommand', 'startCommand', 'healthCheckPath', 'autoDeployTrigger']) {
    assert.equal(free[key], paid[key], `${key} is the same as in render.yaml`);
  }
  assert.notEqual(free.name, paid.name, 'the demo cannot be mistaken for the real site in the same Render account');
});

test('render-free.yaml asks for the same boxes as render.yaml, and keeps secrets out', () => {
  assert.doesNotMatch(read('render-free.yaml'), /rzp_(test|live)_[A-Za-z0-9]{6,}/, 'no Razorpay key in the file');
  const free = varsOf(freeBlueprint());
  const paid = varsOf(blueprint());
  const boxes = (vars) => Object.values(vars).filter((v) => v.sync === false).map((v) => v.key);

  assert.deepEqual(boxes(free), boxes(paid), 'the guide\'s list of boxes fits both files');
  assert.equal(free.NODE_ENV.value, 'production');
  assert.equal(free.NODE_VERSION.value, paid.NODE_VERSION.value);
  for (const v of Object.values(free)) assert.equal('value' in v, v.sync !== false, `${v.key} has a value or a form box`);
  for (const key of ['TRUST_PROXY', 'PORT', 'HOST']) assert.ok(!(key in free), `${key} is chosen by the site on Render`);
});

test('render-free.yaml saves bookings in a temporary folder, and the site says plainly that they do not last', () => {
  const { DATA_DIR } = varsOf(freeBlueprint());
  assert.ok(DATA_DIR && DATA_DIR.value, 'DATA_DIR is set: with no disk, the site must not look for /var/data');
  const dir = DATA_DIR.value;
  assert.ok(path.isAbsolute(dir) && dir.startsWith('/tmp/'), 'a folder that every Render service may write to');

  const c = loadConfig({ RENDER: 'true', NODE_ENV: 'production', DATA_DIR: dir, RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' });
  assert.equal(c.dataDir, dir);
  assert.equal(c.dataOnRenderDisk, false, 'the site knows these bookings are temporary, and warns about it');
  assert.equal(c.trustProxy, 1);
  assert.equal(c.host, '0.0.0.0');
  // The warning in the dashboard's Setup check explains that this is expected on the free size.
  assert.match(read('public/js/dashboard.js'), /Exception: the free demo \(render-free\.yaml\) has no disk, so there this is expected: leave DATA_DIR as it is/);
});

test('every setting in render-free.yaml is one the site reads, and is in .env.example', () => {
  const code = read('src/config.js');
  const example = read('.env.example');
  for (const { key } of freeBlueprint().services[0].envVars) {
    if (key === 'NODE_VERSION') continue; // read by Render itself
    assert.ok(code.includes(`env.${key}`), `src/config.js reads ${key}`);
    assert.ok(new RegExp(`^#?\\s*${key}=`, 'm').test(example), `.env.example describes ${key}`);
  }
});

test('the guide and the README explain the free demo and what it cannot do', () => {
  const guide = read('DEPLOY-RENDER.md');
  for (const word of ['render-free.yaml', 'Blueprint Path', 'A free demo first', 'parking-site-demo', '15 minutes', 'test keys']) {
    assert.ok(guide.includes(word), `the guide mentions ${word}`);
  }
  assert.ok(read('README.md').includes('render-free.yaml'), 'the README lists render-free.yaml');
});
