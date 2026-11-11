'use strict';

// The database layer against a REAL Postgres. Skipped unless TEST_DATABASE_URL points at one, for example:
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/bayfind npm test
// Use an empty database that exists only for testing: these tests delete the "test:" records in it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Database, TABLE } = require('../src/database');
const { openStorage } = require('../src/storage');
const { loadConfig } = require('../src/config');
const { makeSite, pay, car } = require('./helpers');

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : 'set TEST_DATABASE_URL to run the tests against a real Postgres';
const silent = { info() {}, warn() {}, error() {} };

async function fresh(t) {
  const db = Database.connect(URL, { log: silent });
  await db.init();
  await db.pool.query(`DELETE FROM ${TABLE} WHERE kind LIKE 'test:%' OR kind LIKE 'live:%'`);
  t.after(async () => {
    await db.pool.query(`DELETE FROM ${TABLE} WHERE kind LIKE 'test:%' OR kind LIKE 'live:%'`);
    await db.close();
  });
  return db;
}

const put = (db, kind, docs) => db.apply(kind, docs.map((d) => ({ id: d.id, json: JSON.stringify(d) })), []);

test('postgres: init can run twice, and documents are written, read back in order, changed and deleted', { skip }, async (t) => {
  const db = await fresh(t);
  await db.init();
  await put(db, 'test:booking', [
    { id: 'c', createdAt: 30, status: 'pending' },
    { id: 'a', createdAt: 10, status: 'paid' },
    { id: 'b', createdAt: 20, status: 'paid' },
    { id: 'z' }, // no createdAt: last
  ]);
  assert.deepEqual((await db.load('test:booking')).map((d) => d.id), ['a', 'b', 'c', 'z'], 'oldest first');

  await put(db, 'test:booking', [{ id: 'c', createdAt: 30, status: 'paid' }]);
  assert.equal((await db.load('test:booking')).find((d) => d.id === 'c').status, 'paid');
  await db.apply('test:booking', [], ['a', 'z', 'does-not-exist']);
  assert.deepEqual((await db.ids('test:booking')).sort(), ['b', 'c']);
  assert.deepEqual((await db.docs('test:booking', ['b', 'nope'])).map((d) => d.id), ['b']);
  assert.deepEqual(await db.load('test:user'), [], 'another kind is separate');
});

test('postgres: awkward text survives (quotes, backslashes, unicode, rupee sign, newlines, braces)', { skip }, async (t) => {
  const db = await fresh(t);
  const doc = {
    id: 'bk_1',
    createdAt: 1,
    note: 'He said "park here" \\ and left\nnext line\ttab {"a":[1,2]} \' $1 ; DROP TABLE x; --',
    amount: '₹120 — नमस्ते — 🚗',
    nested: { list: [1, 2.5, null, true, 'x'], empty: {} },
    nothing: null,
  };
  await put(db, 'test:booking', [doc]);
  assert.deepEqual((await db.load('test:booking'))[0], doc);
});

test('postgres: more than one chunk of documents, and a failed write changes nothing', { skip }, async (t) => {
  const db = await fresh(t);
  const many = Array.from({ length: 450 }, (_, i) => ({ id: `bk_${String(i).padStart(4, '0')}`, createdAt: i }));
  await put(db, 'test:booking', many);
  assert.equal((await db.ids('test:booking')).length, 450);

  // the second document is not valid JSON: the whole write is refused and the first is not saved either
  await assert.rejects(db.apply('test:booking', [{ id: 'good', json: '{"id":"good"}' }, { id: 'bad', json: '{not json' }], ['bk_0000']));
  const ids = await db.ids('test:booking');
  assert.equal(ids.length, 450);
  assert.ok(!ids.includes('good'));
  assert.ok(ids.includes('bk_0000'), 'the delete was rolled back too');
  assert.equal((await db.pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the connection is still usable');
});

test('postgres: two copies starting together end up with the same sign-in key', { skip }, async (t) => {
  const db = await fresh(t);
  await db.pool.query(`DELETE FROM ${TABLE} WHERE kind = 'meta' AND id = 'session-key'`);
  const keys = await Promise.all([1, 2, 3, 4].map((n) => db.sessionKey(Buffer.alloc(48, n))));
  for (const k of keys) assert.deepEqual(k, keys[0]);
  assert.equal(keys[0].length, 48);
  assert.deepEqual(await db.sessionKey(Buffer.alloc(48, 9)), keys[0], 'later calls read the stored one');
});

test('postgres: the whole site works on it, and a restart finds everything', { skip }, async (t) => {
  const db = await fresh(t);
  const a = await makeSite({ razorpayKeys: true, database: db, env: { CUSTOMER_LOGIN_REQUIRED: 'on' } });
  const up = await a.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  assert.equal(up.status, 201, up.text);
  const cookie = up.headers.getSetCookie().find((c) => c.startsWith('bf_session=')).split(';')[0];
  const created = await a.post('/api/bookings', car(), { headers: { cookie } });
  assert.equal(created.status, 201, created.text);
  const paid = await pay(a, created, 'pay_pg1');
  assert.equal(paid.json.status, 'paid');
  await a.close();

  const rows = (await db.pool.query(`SELECT kind, count(*)::int AS n FROM ${TABLE} WHERE kind LIKE 'test:%' GROUP BY kind ORDER BY kind`)).rows;
  assert.deepEqual(rows, [{ kind: 'test:booking', n: 1 }, { kind: 'test:user', n: 1 }]);

  const b = await makeSite({ razorpayKeys: true, database: db, env: { CUSTOMER_LOGIN_REQUIRED: 'on' }, startAt: a.clock.t });
  t.after(() => b.close());
  assert.equal(b.store.bookings.length, 1);
  assert.equal(b.store.bookings[0].paymentId, 'pay_pg1');
  const me = await b.get('/api/me', { headers: { cookie } });
  assert.equal(me.json.user.email, 'asha@example.com');
});

test('postgres: the site stops with a clear message when the address is wrong', { skip }, async () => {
  const bad = URL.replace(/\/[^/?]*(\?|$)/, '/no_such_database_here$1');
  const config = loadConfig({ DATABASE_URL: bad });
  const waits = [];
  await assert.rejects(openStorage(config, { log: silent, wait: async (ms) => waits.push(ms) }), /could not be reached/);
  assert.equal(waits.length, 5);
});
