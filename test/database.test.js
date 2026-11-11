'use strict';

// Keeping bookings and customer accounts in a database (DATABASE_URL) instead of files. These tests use a pretend
// database kept in memory that can be switched "down". test/postgres.test.js runs the same kind of checks against a real
// Postgres when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { DocSync } = require('../src/docsync');
const { openStorage } = require('../src/storage');
const { Store } = require('../src/store');
const { makeSite, fakeDatabase, bookAndPay, pay, car, signedWebhook, webhookEvent, basic } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const URL_OK = 'postgresql://user:hunter2secret@db.example.test/bayfind';
const KIND = 'test:booking';
const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const ADMIN = { headers: { authorization: basic('operator', OP.OPERATOR_PASSWORD) } };

function recordingLog() {
  const lines = { info: [], warn: [], error: [] };
  return { lines, info: (m) => lines.info.push(String(m)), warn: (m) => lines.warn.push(String(m)), error: (m) => lines.error.push(String(m)) };
}

// A list of records watched by a DocSync, the way a Store does it.
function watched(db, { retryMs = [5, 5], log = recordingLog() } = {}) {
  const sync = new DocSync({ db, kind: KIND, log, retryMs });
  const list = [];
  sync.prime([]);
  sync.list = () => list;
  return { sync, list, log };
}

// ---- DocSync ---------------------------------------------------------------------------------------------

test('only records that changed are written, and records that were removed are deleted', async () => {
  const db = fakeDatabase();
  const { sync, list } = watched(db);
  list.push({ id: 'a', n: 1 }, { id: 'b', n: 1 });
  await sync.settled();
  assert.deepEqual(db.calls.apply.map((c) => c.upserts), [['a', 'b']]);

  list[1].n = 2;
  await sync.settled();
  assert.deepEqual(db.calls.apply[1].upserts, ['b'], 'only the changed one');

  list.splice(0, 1);
  await sync.settled();
  assert.deepEqual(db.calls.apply[2], { kind: KIND, upserts: [], deletes: ['a'] });
  assert.deepEqual(db.docs_of(KIND), [{ id: 'b', n: 2 }]);

  const before = db.calls.apply.length;
  await sync.settled();
  assert.equal(db.calls.apply.length, before, 'nothing changed, so nothing is written');
});

test('a change made while a write is under way is written right after it', async () => {
  const db = fakeDatabase();
  db.state.delayMs = 30;
  const { sync, list } = watched(db);
  list.push({ id: 'a', n: 1 });
  const first = sync.settled();
  await sleep(5);
  list[0].n = 2; // changed while the first write is still going
  const second = sync.settled();
  await Promise.all([first, second]);
  assert.deepEqual(db.docs_of(KIND), [{ id: 'a', n: 2 }]);
});

test('while the database is down settled() fails, the change stays in memory, and it is saved once the database is back', async () => {
  const db = fakeDatabase();
  const { sync, list, log } = watched(db);
  db.state.down = true;
  list.push({ id: 'a', n: 1 });
  await assert.rejects(sync.settled(), /connection refused/);
  assert.equal(sync.errorText, 'connection refused');
  assert.equal(list.length, 1, 'still in memory');

  db.state.down = false;
  await sleep(40); // the retry runs by itself
  assert.equal(sync.errorText, null);
  assert.deepEqual(db.docs_of(KIND), [{ id: 'a', n: 1 }]);
  assert.equal(log.lines.error.length, 1, 'the same failure is logged once, not on every retry');
  assert.match(log.lines.error[0], /COULD NOT SAVE the test:booking records/);
  assert.ok(log.lines.info.some((m) => /accepts test:booking changes again/.test(m)));
  await sync.close();
});

test('after a failure with nothing left to write, the error only clears once the database really answers', async () => {
  const db = fakeDatabase();
  const { sync, list } = watched(db);
  db.state.down = true;
  list.push({ id: 'a' });
  await assert.rejects(sync.settled());
  list.length = 0; // nothing left to write
  await sleep(20);
  assert.equal(sync.errorText, 'connection refused', 'still down: a retry with nothing to write checks the database');
  db.state.down = false;
  await sleep(30);
  assert.equal(sync.errorText, null);
  assert.ok(db.calls.ping >= 1);
  await sync.close();
});

test('settledWithin gives up after the time and never throws', async () => {
  const db = fakeDatabase();
  const { sync, list } = watched(db);
  db.state.delayMs = 200;
  list.push({ id: 'a' });
  assert.equal(await sync.settledWithin(20), false, 'too slow');
  db.state.delayMs = 0;
  db.state.down = true;
  assert.equal(await sync.settledWithin(500), false, 'down');
  db.state.down = false;
  assert.equal(await sync.settledWithin(500), true, 'saved');
  await sync.close();
});

test('records another copy of the site saved are taken in, and nothing known is touched', async () => {
  const db = fakeDatabase();
  const { sync, list } = watched(db);
  list.push({ id: 'mine', n: 1 });
  await sync.settled();
  sync.adopted = (doc) => list.push(doc);

  // the other copy saved a new record and also changed one of ours
  await db.apply(KIND, [{ id: 'theirs', json: JSON.stringify({ id: 'theirs', n: 9 }) }, { id: 'mine', json: JSON.stringify({ id: 'mine', n: 99 }) }], []);
  assert.equal(await sync.adopt(), 1);
  assert.deepEqual(list, [{ id: 'mine', n: 1 }, { id: 'theirs', n: 9 }], 'a known record is never overwritten');
  assert.equal(await sync.adopt(), 0, 'nothing new the second time');
});

test('a record removed here but not yet deleted there is not brought back', async () => {
  const db = fakeDatabase();
  const { sync, list } = watched(db);
  list.push({ id: 'a' });
  await sync.settled();
  sync.adopted = (doc) => list.push(doc);
  list.length = 0; // removed here; the delete has not been sent yet
  assert.equal(await sync.adopt(), 0);
  assert.deepEqual(list, []);
});

// ---- Opening the storage -----------------------------------------------------------------------------------

test('without DATABASE_URL the bookings and accounts stay in files, as before', async () => {
  const config = loadConfig({ DATA_DIR: require('node:os').tmpdir() });
  const storage = await openStorage(config);
  assert.equal(storage.kind, 'files');
  assert.ok(storage.store instanceof Store);
  assert.equal(storage.store.syncError, null);
  assert.equal(await storage.store.settledWithin(10), true);
  await storage.store.settled();
});

test('with DATABASE_URL everything is loaded from the database before the site starts, test and live kept apart', async () => {
  const db = fakeDatabase();
  await db.apply('test:booking', [{ id: 'bk_t', json: JSON.stringify({ id: 'bk_t', createdAt: 5, status: 'paid' }) }], []);
  await db.apply('live:booking', [{ id: 'bk_l', json: JSON.stringify({ id: 'bk_l', createdAt: 5, status: 'paid' }) }], []);
  await db.apply('test:user', [{ id: 'usr_aaaaaaaaaaaa', json: JSON.stringify({ id: 'usr_aaaaaaaaaaaa', createdAt: 1 }) }], []);

  const testing = await openStorage(loadConfig({ DATABASE_URL: URL_OK, RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' }), { database: db });
  assert.equal(testing.kind, 'database');
  assert.deepEqual(testing.store.bookings.map((b) => b.id), ['bk_t']);
  assert.deepEqual(testing.users.users.map((u) => u.id), ['usr_aaaaaaaaaaaa']);

  const live = await openStorage(loadConfig({ DATABASE_URL: URL_OK, RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's' }), { database: db });
  assert.deepEqual(live.store.bookings.map((b) => b.id), ['bk_l'], 'switching to live keys starts with the live records, not the test ones');
  assert.deepEqual(live.users.users, []);
});

test('the site never starts empty: it waits for a database that is not there yet, then stops with a clear message', async () => {
  const db = fakeDatabase();
  db.state.down = true;
  const log = recordingLog();
  const waits = [];
  const config = loadConfig({ DATABASE_URL: URL_OK });
  await assert.rejects(
    openStorage(config, { database: db, log, wait: async (ms) => waits.push(ms) }),
    (err) => {
      assert.match(err.message, /database at db\.example\.test could not be reached: connection refused/);
      assert.ok(!err.message.includes('hunter2secret'), 'the password is never in the message');
      return true;
    }
  );
  assert.equal(waits.length, 5, 'six tries, five pauses');
  assert.ok(log.lines.warn.every((m) => !m.includes('hunter2secret')));

  // it was only asleep: the third try works
  const db2 = fakeDatabase();
  let tries = 0;
  const realLoad = db2.load.bind(db2);
  db2.load = async (k) => {
    tries += 1;
    if (tries < 3) throw new Error('timeout');
    return realLoad(k);
  };
  const storage = await openStorage(config, { database: db2, log: recordingLog(), wait: async () => {} });
  assert.equal(storage.kind, 'database');
});

test('an address that is not a Postgres address stops the site with a clear message', async () => {
  for (const url of ['mysql://u:p@h/db', 'not a url', 'https://example.com']) {
    const config = loadConfig({ DATABASE_URL: url });
    assert.equal(config.database.valid, false, url);
    await assert.rejects(openStorage(config, { database: fakeDatabase() }), /not a Postgres address/);
  }
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require' }).database.valid, true);
  assert.equal(loadConfig({}).database.valid, true, 'no database is fine');
});

test('the sign-in key lives in the database, so customers stay signed in across restarts; SESSION_SECRET wins when set', async () => {
  const db = fakeDatabase();
  const a = await openStorage(loadConfig({ DATABASE_URL: URL_OK }), { database: db });
  const b = await openStorage(loadConfig({ DATABASE_URL: URL_OK }), { database: db });
  assert.ok(Buffer.isBuffer(a.sessionKey) && a.sessionKey.length >= 32);
  assert.deepEqual(a.sessionKey, b.sessionKey);
  const own = await openStorage(loadConfig({ DATABASE_URL: URL_OK, SESSION_SECRET: 'x'.repeat(40) }), { database: db });
  assert.equal(own.sessionKey, null);
});

test('config: a database lifts the temporary-storage block on live keys, and the address is never echoed', () => {
  const live = { RENDER: 'true', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 's', DATA_DIR: '/tmp/somewhere' };
  assert.equal(loadConfig(live).unsafeLiveStorage, true, 'no database: still blocked');
  const withDb = loadConfig({ ...live, DATABASE_URL: URL_OK });
  assert.equal(withDb.unsafeLiveStorage, false);
  assert.equal(withDb.database.scope, 'live');
  assert.equal(withDb.database.host, 'db.example.test');
  assert.equal(loadConfig({ DATABASE_URL: URL_OK, RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 's' }).database.scope, 'test');
  assert.equal(loadConfig({ DATABASE_URL: URL_OK }).database.scope, 'test');
});

// ---- The site on a database --------------------------------------------------------------------------------

test('a paid booking is in the database, and after a restart the payment and the booking are still there', async (t) => {
  const db = fakeDatabase();
  const a = await makeSite({ razorpayKeys: true, database: db });
  const { created, paid } = await bookAndPay(a, car(), 'pay_db1');
  assert.equal(created.status, 201, created.text);
  assert.equal(paid.json.status, 'paid');
  const saved = db.docs_of(KIND);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'paid');
  assert.equal(saved[0].paymentId, 'pay_db1');
  assert.ok(saved[0].orderId, 'the order id is saved');
  assert.equal(db.calls.apply.at(-1).kind, KIND);

  await a.close(); // the site restarts: a second copy opens the same database
  const b = await makeSite({ razorpayKeys: true, database: db, startAt: a.clock.t });
  t.after(() => b.close());
  assert.equal(b.store.bookings.length, 1);
  const again = await b.post('/api/bookings', car());
  assert.equal(again.status, 409, 'the booking paid for before the restart is still known: the same vehicle cannot book that time again');
  // the same payment arriving late (webhook) finds its booking and does not double anything
  const hook = signedWebhook(webhookEvent('payment.captured', saved[0].orderId, 'pay_db1'));
  const res = await b.post('/api/razorpay/webhook', undefined, { raw: hook.raw, headers: hook.headers });
  assert.equal(res.status, 200, res.text);
  assert.equal(b.store.bookings.length, 1);
  assert.equal(b.fake.calls.refunds.length, 0);
});

test('nobody is sent to pay for a booking that could not be saved: the database fails right at the payment step', async (t) => {
  const db = fakeDatabase();
  const log = recordingLog();
  const s = await makeSite({ razorpayKeys: true, database: db, log });
  t.after(() => s.close());
  db.state.down = true; // goes down after the site started, before anything noticed
  const r = await s.post('/api/bookings', car());
  assert.equal(r.status, 503, r.text);
  assert.equal(r.json.error, 'storage_unavailable');
  assert.match(r.json.message, /Nothing was charged/);
  assert.equal(s.store.bookings.length, 0, 'the unsaved hold was dropped');
  assert.ok(log.lines.error.some((m) => /could not be saved to the database, so the payment was not started/.test(m)));
  // the dashboard says so
  const status = s.bookings.paymentStatus();
  assert.equal(status.acceptingPayments, false);
  assert.ok(status.problems.some((p) => p.level === 'bad' && /database is not accepting changes/.test(p.text)));

  // a later attempt while the database is still down is refused up front, without even asking Razorpay for an order
  const orders = s.fake.calls.orders.length;
  const again = await s.post('/api/bookings', car());
  assert.equal(again.status, 503);
  assert.equal(s.fake.calls.orders.length, orders);

  // the database comes back: booking works again by itself
  db.state.down = false;
  await sleep(2100);
  const ok = await s.post('/api/bookings', car());
  assert.equal(ok.status, 201, ok.text);
  assert.equal(db.docs_of(KIND).filter((b) => b.status === 'pending' && b.orderId).length, 1, 'the order id is in the database before the customer is sent to pay');
});

test('the order id is already in the database when the customer is sent to the payment window', async (t) => {
  const db = fakeDatabase();
  const s = await makeSite({ razorpayKeys: true, database: db });
  t.after(() => s.close());
  const created = await s.post('/api/bookings', car());
  assert.equal(created.status, 201, created.text);
  const inDb = db.docs_of(KIND).find((b) => b.orderId === created.json.payment.orderId);
  assert.ok(inDb, 'saved before the response');
  assert.equal(inDb.status, 'pending');
});

test('a payment that was never confirmed in the browser is still found after a restart, because the order id was saved', async (t) => {
  const db = fakeDatabase();
  const a = await makeSite({ razorpayKeys: true, database: db });
  const created = await a.post('/api/bookings', car());
  const orderId = created.json.payment.orderId;
  await a.close(); // the customer paid, but the site restarted before anything was confirmed

  const b = await makeSite({ razorpayKeys: true, database: db, startAt: a.clock.t });
  t.after(() => b.close());
  b.fake.state.payments[orderId] = [{ id: 'pay_late', status: 'captured', amount: db.docs_of(KIND)[0].amountPaise, currency: 'INR' }];
  b.advance(30 * 60 * 1000);
  const found = await b.bookings.reconcile();
  assert.equal(found, 1, 'the once-a-minute check settles it');
  assert.equal(db.docs_of(KIND)[0].status, 'paid');
});

test('a refund that is under way is already marked in the database when the request goes to Razorpay', async (t) => {
  const db = fakeDatabase();
  const s = await makeSite({ razorpayKeys: true, database: db, env: OP });
  t.after(() => s.close());
  const { created, paid } = await bookAndPay(s, car(), 'pay_r1');
  assert.equal(paid.json.status, 'paid');
  s.fake.state.refundDelayMs = 80;
  const cancel = s.post(`/api/dashboard/bookings/${created.json.booking.ref}/cancel`, {}, ADMIN);
  await sleep(40); // the refund request is now with Razorpay
  assert.equal(db.docs_of(KIND)[0].status, 'refund_pending', 'a restart now would know a refund was in flight');
  const res = await cancel;
  assert.equal(res.status, 200, res.text);
  assert.equal(db.docs_of(KIND)[0].status, 'refunded');
});

test('customer accounts are in the database, with the password only as a hash, and survive a restart', async (t) => {
  const db = fakeDatabase();
  const env = { CUSTOMER_LOGIN_REQUIRED: 'on' };
  const a = await makeSite({ database: db, env });
  const up = await a.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  assert.equal(up.status, 201, up.text);
  const cookie = up.headers.getSetCookie().find((c) => c.startsWith('bf_session=')).split(';')[0];
  const users = db.docs_of('test:user');
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'asha@example.com');
  assert.ok(!JSON.stringify(users).includes('a-good-password'));
  assert.match(users[0].pass, /^s1\$/);
  await a.close();

  const b = await makeSite({ database: db, env });
  t.after(() => b.close());
  const me = await b.get('/api/me', { headers: { cookie } });
  assert.equal(me.json.user.email, 'asha@example.com', 'the same sign-in cookie still works: the key is kept in the database');
  const login = await b.post('/api/auth/login', { identifier: 'asha@example.com', password: 'a-good-password' });
  assert.equal(login.status, 200, login.text);
});

test('live keys on a free Render site take payments once a database is connected, and still refuse without one', async (t) => {
  const render = { RENDER: 'true', RAZORPAY_KEY_ID: 'rzp_live_abc123', RAZORPAY_KEY_SECRET: 'live_secret_value', NODE_ENV: 'production', ...OP };
  const db = fakeDatabase();
  const withDb = await makeSite({ database: db, env: render });
  t.after(() => withDb.close());
  assert.equal(withDb.bookings.paymentMode, 'razorpay');
  const status = withDb.bookings.paymentStatus();
  assert.equal(status.live, true);
  assert.equal(status.storage, 'database');
  assert.equal(status.storageKept, true);
  assert.ok(!status.problems.some((p) => /temporary storage/.test(p.text)));
  const made = await withDb.post('/api/bookings', car());
  assert.equal(made.status, 201, made.text);
  assert.equal(db.docs_of('live:booking').length, 1, 'real bookings go to the live records');
  assert.equal(db.docs_of('test:booking').length, 0);

  const without = await makeSite({ env: render });
  t.after(() => without.close());
  assert.equal(without.bookings.paymentMode, 'unavailable');
  assert.equal(without.bookings.unavailableReason, 'temporary_storage');
  assert.match(without.bookings.paymentStatus().problems.find((p) => p.level === 'bad').text, /DATABASE_URL/);
});

test('the setup check on the dashboard says the bookings are in the database, and shows its trouble', async (t) => {
  const db = fakeDatabase();
  const s = await makeSite({ razorpayKeys: true, database: db, env: { ...OP, RENDER: 'true' } });
  t.after(() => s.close());
  const ok = (await s.get('/api/dashboard/connection', ADMIN)).json;
  assert.equal(ok.storage.kind, 'database');
  assert.equal(ok.storage.database, 'db.example.test');
  assert.equal(ok.storage.databaseError, null);
  assert.equal(ok.storage.folder, null);
  assert.ok(!JSON.stringify(ok).includes('hunter2'), 'no password anywhere');
  assert.ok(!JSON.stringify(ok).includes('secret@'), 'no password anywhere');

  db.state.down = true;
  const refused = await s.post('/api/bookings', car());
  assert.equal(refused.status, 503);
  const bad = (await s.get('/api/dashboard/connection', ADMIN)).json;
  assert.equal(bad.storage.databaseError, 'connection refused');
});

test('with sample data the database holds it too, and removing it deletes it there', async (t) => {
  const db = fakeDatabase();
  const s = await makeSite({ database: db, env: OP });
  t.after(() => s.close());
  assert.equal(s.bookings.paymentMode, 'demo');
  s.bookings.addSampleData();
  await s.store.settled();
  assert.ok(db.docs_of(KIND).length > 0);
  s.bookings.removeSampleData();
  await s.store.settled();
  assert.equal(db.docs_of(KIND).length, 0);
});

test('during an update two copies run: a payment for a booking the other copy saved is still found, through the database', async (t) => {
  const db = fakeDatabase();
  const oldCopy = await makeSite({ razorpayKeys: true, database: db });
  const newCopy = await makeSite({ razorpayKeys: true, database: db }); // started a moment earlier: knows nothing of what follows
  t.after(() => newCopy.close());
  t.after(() => oldCopy.close());

  const created = await oldCopy.post('/api/bookings', car());
  assert.equal(created.status, 201, created.text);
  const orderId = created.json.payment.orderId;
  assert.equal(newCopy.store.bookings.length, 0, 'the new copy has not heard of it');

  const amount = db.docs_of(KIND)[0].amountPaise;
  const hook = await newCopy.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('payment.captured', orderId, 'pay_two', amount)));
  assert.equal(hook.status, 200, hook.text);
  assert.equal(hook.json.outcome, 'paid', 'found in the database, then settled');
  assert.equal(db.docs_of(KIND)[0].status, 'paid');
  assert.equal(newCopy.store.bookings.length, 1);

  // an order nobody has heard of is still ignored, after one look in the database
  const unknown = await newCopy.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('payment.captured', 'order_SOMEONEELSE', 'pay_x', 100)));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.ignored, 'unknown_order');
});

test('with files nothing looks anywhere else: an unknown order is ignored at once', async (t) => {
  const s = await makeSite({ razorpayKeys: true });
  t.after(() => s.close());
  assert.equal(s.bookings.adopt, null);
  const unknown = await s.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('payment.captured', 'order_NOPE', 'pay_x', 100)));
  assert.equal(unknown.json.ignored, 'unknown_order');
});
