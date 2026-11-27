'use strict';

// Many people at once. The site keeps its records in one process and decides a bay, a payment or a scan before it waits for
// anything, so two requests that arrive together cannot both win. These tests send the requests together and check that.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSite, pay, sign, car, bike, webhookEvent, signedWebhook, MINUTE } = require('./helpers');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
// Every request comes from a different address, as a crowd would; otherwise the per-address limits (which are tested elsewhere) answer first.
const crowd = (i) => ({ headers: { 'x-forwarded-for': `10.${(i >> 8) & 255}.${i & 255}.7` } });
const plateOf = (i) => `MP09AB${String(1000 + i)}`.slice(0, 10);

async function site(t, env = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { TRUST_PROXY: '1', ...OP, ...env } });
  t.after(() => s.close());
  return s;
}
const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;

test('120 people booking the same hour in a zone of 50 bays: exactly 50 get a bay, each a different one', async (t) => {
  const s = await site(t);
  const answers = await Promise.all(Array.from({ length: 120 }, (_, i) => s.post('/api/bookings', car({ plate: plateOf(i), zone: 0 }), crowd(i))));
  const made = answers.filter((r) => r.status === 201);
  const refused = answers.filter((r) => r.status !== 201);
  assert.equal(made.length, 50, 'one booking for every bay in the zone');
  assert.equal(refused.length, 70);
  assert.ok(refused.every((r) => r.status === 409 && r.json.error === 'zone_full'), JSON.stringify(refused.slice(0, 2).map((r) => r.text)));

  const bays = made.map((r) => r.json.booking.bay);
  assert.equal(new Set(bays).size, 50, 'no bay was given twice');
  assert.ok(bays.every((b) => /^C\d{3}$/.test(b)));
  // nothing in the records overlaps on one bay
  const rows = s.store.bookings.filter((b) => b.status === 'pending');
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (rows[i].bay === rows[j].bay) assert.ok(!overlaps(rows[i], rows[j]), `${rows[i].bay} is double booked`);
});

test('bookings of different times share bays without a clash, however they arrive', async (t) => {
  const s = await site(t);
  // 100 people for the 2-wheeler zone (50 bays): half want 11:00 to 13:00, half want 12:00 to 14:00, so the windows overlap in the middle hour
  const answers = await Promise.all(Array.from({ length: 100 }, (_, i) => s.post('/api/bookings', bike({ plate: plateOf(i), zone: 0, time: i % 2 ? '12:00' : '11:00' }), crowd(i))));
  const made = answers.filter((r) => r.status === 201).length;
  assert.ok(made >= 50 && made <= 100, `${made} bookings`);
  const rows = s.store.bookings.filter((b) => b.status === 'pending');
  assert.equal(rows.length, made);
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (rows[i].bay === rows[j].bay) assert.ok(!overlaps(rows[i], rows[j]), `${rows[i].bay} is double booked`);
  // at the busiest moment (12:00 to 13:00) both groups are parked: never more than the 50 bays of the zone
  const middle = { startMs: rows[0].startMs + 60 * MINUTE, endMs: rows[0].startMs + 120 * MINUTE };
  assert.ok(rows.filter((b) => overlaps(b, { startMs: Math.max(b.startMs, middle.startMs), endMs: middle.endMs }) && overlaps(b, middle)).length <= 50);
});

test('the same vehicle asked for ten times at once leaves one hold, not ten', async (t) => {
  const s = await site(t);
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => s.post('/api/bookings', car({ plate: 'MP09ZZ9999', zone: i % 4 }), crowd(i))));
  assert.ok(answers.every((r) => r.status === 201), 'every request is answered properly');
  const holds = s.store.bookings.filter((b) => b.plate === 'MP09ZZ9999' && b.status === 'pending');
  assert.equal(holds.length, 1, 'a new try from the same vehicle replaces its own earlier hold');
});

test('50 payments confirmed at once: each booking is paid exactly once', async (t) => {
  const s = await site(t);
  const created = [];
  for (let i = 0; i < 50; i++) {
    const r = await s.post('/api/bookings', car({ plate: plateOf(i), zone: 1 }), crowd(i));
    assert.equal(r.status, 201, r.text);
    created.push(r);
  }
  const paid = await Promise.all(
    created.map((r, i) => {
      const orderId = r.json.payment.orderId;
      return s.post('/api/payments/verify', { razorpay_order_id: orderId, razorpay_payment_id: 'pay_c' + i, razorpay_signature: sign(orderId, 'pay_c' + i) }, crowd(i));
    })
  );
  assert.ok(paid.every((r) => r.status === 200), JSON.stringify(paid.filter((r) => r.status !== 200).slice(0, 2).map((r) => r.text)));
  const rows = s.store.bookings.filter((b) => b.status === 'paid');
  assert.equal(rows.length, 50);
  assert.equal(new Set(rows.map((b) => b.paymentId)).size, 50, 'no payment was used for two bookings');
  assert.equal(new Set(rows.map((b) => b.bay)).size, 50);
});

test('the browser and Razorpay both confirm the same payment at the same moment: it counts once and nothing is refunded', async (t) => {
  const s = await site(t);
  const created = await s.post('/api/bookings', car());
  const orderId = created.json.payment.orderId;
  const hook = signedWebhook(webhookEvent('payment.captured', orderId, 'pay_race', 8000));
  const answers = await Promise.all([
    pay(s, created, 'pay_race'),
    pay(s, created, 'pay_race'),
    s.post('/api/razorpay/webhook', undefined, hook),
    s.post('/api/razorpay/webhook', undefined, hook),
    pay(s, created, 'pay_race'),
    s.post('/api/razorpay/webhook', undefined, hook),
  ]);
  assert.ok(answers.every((r) => r.status === 200), JSON.stringify(answers.map((r) => r.status)));
  const rows = s.store.bookings.filter((b) => b.id === created.json.booking.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[0].paymentId, 'pay_race');
  assert.equal(s.store.bookings.filter((b) => b.status === 'paid').length, 1);
  assert.equal(s.refunds ? s.refunds.length : 0, 0, 'no money was sent back');
});

test('one entry QR scanned by twenty phones at once lets one vehicle in', async (t) => {
  const s = await site(t);
  const created = await s.post('/api/bookings', car());
  await pay(s, created, 'pay_gate');
  const booking = s.store.bookings.find((b) => b.id === created.json.booking.id);
  const login = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('bf_session=')).split(';')[0];
  s.clock.t += 50 * MINUTE; // 10:50: inside the early-arrival window
  const token = s.app.locals.gate.tokenFor('in', booking);
  const answers = await Promise.all(Array.from({ length: 20 }, () => s.post('/api/dashboard/gate/scan', { token }, { headers: { cookie, accept: 'application/json' } })));
  const entered = answers.filter((r) => r.status === 200 && r.json.outcome === 'entered');
  assert.equal(entered.length, 1, JSON.stringify(answers.map((r) => [r.status, r.json && r.json.outcome])));
  assert.equal(answers.filter((r) => r.status === 200 && r.json.outcome === 'already_entered').length, 19, 'the other nineteen are told the vehicle is already in');
  assert.equal(typeof booking.entryAt, 'number');
});
