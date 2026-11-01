'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { hmacHex } = require('../src/payments');
const {
  KEY_ID, KEY_SECRET, WEBHOOK_SECRET, MINUTE,
  makeSite, sign, pay, bookAndPay, car, bike, AVAILABILITY_URL, webhookEvent, signedWebhook, basic,
} = require('./helpers');

const HOUR = 60 * MINUTE;

// Starts a site and makes sure it is shut down when the test ends.
async function site(t, options) {
  const s = await makeSite(options);
  t.after(() => s.close());
  return s;
}

// Books with Razorpay (the pretend one) and leaves the booking unpaid.
async function pendingOrder(s, over = {}) {
  const created = await s.post('/api/bookings', car(over));
  assert.equal(created.status, 201, created.text);
  return { created, id: created.json.booking.id, orderId: created.json.payment.orderId, ref: created.json.booking.ref };
}

// ===== Payment modes ==================================================================================

test('with Razorpay keys the site publishes the key id and never a secret', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const r = await s.get('/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.payments, { mode: 'razorpay', keyId: KEY_ID, test: true });
  assert.ok(!r.text.includes(KEY_SECRET), 'the key secret must not appear');
  assert.ok(!r.text.includes(WEBHOOK_SECRET), 'the webhook secret must not appear');
  assert.equal(r.json.lot.car.total, 200);
  assert.equal(r.json.lot.bike.total, 250);
  assert.deepEqual(r.json.rates, { car: { weekday: 40, weekend: 60 }, bike: { weekday: 20, weekend: 30 } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('live keys are labelled live', async (t) => {
  const s = await site(t, { env: { RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 'live_secret' } });
  const r = await s.get('/api/config');
  assert.deepEqual(r.json.payments, { mode: 'razorpay', keyId: 'rzp_live_abc', test: false });
});

test('without keys the site runs in demo mode', async (t) => {
  const s = await site(t);
  const r = await s.get('/api/config');
  assert.deepEqual(r.json.payments, { mode: 'demo', keyId: null, test: true });
});

test('in production, no keys means booking is switched off', async (t) => {
  const s = await site(t, { env: { NODE_ENV: 'production' } });
  assert.equal((await s.get('/api/config')).json.payments.mode, 'unavailable');
  const r = await s.post('/api/bookings', car());
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'payments_unavailable');
  assert.equal(s.store.bookings.length, 0);
  assert.equal((await s.post('/api/payments/demo-confirm', { bookingId: 'bk_0123456789abcdef' })).status, 404);
});

test('DEMO_PAYMENTS makes a site in production run in demo mode, for a public demo with no Razorpay keys', async (t) => {
  const s = await site(t, { env: { NODE_ENV: 'production', DEMO_PAYMENTS: 'on', OPERATOR_PASSWORD: 'a long made-up password' } });
  assert.deepEqual((await s.get('/api/config')).json.payments, { mode: 'demo', keyId: null, test: true });
  const { created, paid } = await bookAndPay(s, car());
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.payment, { mode: 'demo', amount: 8000, currency: 'INR' });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.booking.status, 'paid');
  assert.match(s.store.get(created.json.booking.id).paymentId, /^demo_/);
  // The real Razorpay route stays closed, as in any demo mode.
  const r = await s.post('/api/payments/verify', { razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'abc' });
  assert.equal(r.status, 404);
  // The dashboard still needs its password in production, and says the payments are simulated.
  assert.equal((await s.get('/api/dashboard')).status, 401);
  const dash = await s.get('/api/dashboard', { headers: { authorization: basic('operator', 'a long made-up password') } });
  assert.equal(dash.json.paymentMode, 'demo');
});

test('DEMO_PAYMENTS does nothing once Razorpay keys are set: the real checkout is used', async (t) => {
  const s = await site(t, { razorpayKeys: true, env: { NODE_ENV: 'production', DEMO_PAYMENTS: 'on' } });
  assert.deepEqual((await s.get('/api/config')).json.payments, { mode: 'razorpay', keyId: KEY_ID, test: true });
  assert.equal((await s.post('/api/payments/demo-confirm', { bookingId: 'bk_0123456789abcdef' })).status, 404, 'no pretend payment next to the real one');
  const created = await s.post('/api/bookings', car());
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.payment.mode, 'razorpay');
  assert.match(created.json.payment.orderId, /^order_/);
});

test('without DEMO_PAYMENTS a site in production with no keys still switches booking off, whatever else is set', async (t) => {
  for (const off of ['', 'off', '0', 'false']) {
    const s = await site(t, { env: { NODE_ENV: 'production', DEMO_PAYMENTS: off, RENDER: 'true' } });
    assert.equal((await s.get('/api/config')).json.payments.mode, 'unavailable', JSON.stringify(off));
    assert.equal((await s.post('/api/bookings', car())).status, 503);
  }
});

test('the demo payment endpoint does not exist when Razorpay is on, and the real one does not exist in demo mode', async (t) => {
  const live = await site(t, { razorpayKeys: true });
  assert.equal((await live.post('/api/payments/demo-confirm', { bookingId: 'bk_0123456789abcdef' })).status, 404);
  const demo = await site(t);
  const r = await demo.post('/api/payments/verify', { razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'abc' });
  assert.equal(r.status, 404);
});

// ===== Prices ======================================================================================

test('prices are worked out on the server from the rates and the start day', async (t) => {
  const s = await site(t);
  const cases = [
    // vehicle, date, time, hours, day type, rupees
    ['car', '2026-10-14', '11:00', 2, 'weekday', 80], // Wednesday
    ['car', '2026-10-17', '10:00', 2, 'weekend', 120], // Saturday
    ['bike', '2026-10-17', '10:00', 3, 'weekend', 90],
    ['bike', '2026-10-18', '09:00', 1, 'weekend', 30], // Sunday
    ['bike', '2026-10-15', '09:00', 4, 'weekday', 80],
    ['car', '2026-10-16', '23:30', 2, 'weekday', 80], // Friday night, runs into Saturday: Friday's rate
    ['car', '2026-10-17', '00:00', 1, 'weekend', 60], // Saturday 00:00 in India is still Friday in UTC
    ['car', '2026-10-19', '00:00', 1, 'weekday', 40], // Monday 00:00 in India is still Sunday in UTC
  ];
  for (const [vehicle, date, time, hours, dayType, rupees] of cases) {
    const r = await s.get(AVAILABILITY_URL(vehicle, date, time, hours));
    assert.equal(r.status, 200, `${vehicle} ${date} ${time}: ${r.text}`);
    assert.equal(r.json.dayType, dayType, `${vehicle} ${date} ${time}`);
    assert.equal(r.json.amount, rupees, `${vehicle} ${date} ${time}`);
  }
});

test('the amount sent to Razorpay is the server price, whatever the browser claims', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const r = await s.post('/api/bookings', car({ date: '2026-10-17', time: '10:00', hours: 2 })); // Saturday, 2 hours
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.payment, { mode: 'razorpay', keyId: KEY_ID, orderId: r.json.payment.orderId, amount: 12000, currency: 'INR', name: 'Bayfind' });
  assert.match(r.json.payment.orderId, /^order_/);
  assert.deepEqual(s.fake.calls.orders[0], {
    amount: 12000,
    currency: 'INR',
    receipt: r.json.booking.id,
    notes: { booking_ref: r.json.booking.ref, bay: r.json.booking.bay, vehicle_number: 'MP09AB1234' },
  });
  assert.ok(s.fake.calls.orders[0].receipt.length <= 40, 'Razorpay receipts are limited to 40 characters');
  assert.equal(r.json.booking.status, 'pending');
  assert.equal(r.json.booking.amount, 120);

  await s.post('/api/bookings', car({ plate: 'KA01AB9999', amount: 1, price: 1, rate: 1, amountPaise: 1 }));
  assert.equal(s.fake.calls.orders[1].amount, 8000);
});

// ===== Checking requests ======================================================================================

test('bad booking requests are refused with a clear reason and change nothing', async (t) => {
  const s = await site(t);
  const bad = [
    [{ vehicle: 'truck' }, 'invalid_vehicle'],
    [{ vehicle: undefined }, 'invalid_vehicle'],
    [{ vehicle: ['car'] }, 'invalid_vehicle'],
    [{ hours: 5 }, 'invalid_hours'],
    [{ hours: 0 }, 'invalid_hours'],
    [{ hours: 1.5 }, 'invalid_hours'],
    [{ hours: 'abc' }, 'invalid_hours'],
    [{ time: '10:10' }, 'invalid_time'],
    [{ time: '25:00' }, 'invalid_time'],
    [{ time: '10am' }, 'invalid_time'],
    [{ date: '2026-02-31' }, 'invalid_time'],
    [{ date: 'tomorrow' }, 'invalid_time'],
    [{ date: undefined }, 'invalid_time'],
    [{ date: '2026-10-13' }, 'too_early'],
    [{ time: '09:30' }, 'too_early'],
    [{ date: '2026-10-22' }, 'too_late'],
    [{ plate: 'HELLO' }, 'invalid_plate'],
    [{ plate: '' }, 'invalid_plate'],
    [{ plate: undefined }, 'invalid_plate'],
    [{ plate: 12345 }, 'invalid_plate'],
    [{ plate: 'MP09ABCD1234' }, 'invalid_plate'],
    [{ bay: 'B001' }, 'invalid_bay'], // a two-wheeler bay for a car
    [{ bay: 'C201' }, 'invalid_bay'],
    [{ bay: 'C000' }, 'invalid_bay'],
    [{ bay: 'X999' }, 'invalid_bay'],
    [{ zone: 4 }, 'invalid_zone'],
    [{ zone: -1 }, 'invalid_zone'],
    [{ zone: 'abc' }, 'invalid_zone'],
    [{ zone: 1.5 }, 'invalid_zone'],
    [{ zone: null }, 'invalid_zone'],
    [{ zone: '' }, 'invalid_zone'],
    [{ zone: undefined }, 'invalid_zone'],
  ];
  // One refusal through the real address, to see exactly what a visitor gets back...
  const viaHttp = await s.post('/api/bookings', car({ hours: 5 }));
  assert.equal(viaHttp.status, 400);
  assert.equal(viaHttp.json.error, 'invalid_hours');
  assert.ok(viaHttp.json.message.length > 5);
  // ...and the whole table straight against the booking logic (the address limits how many requests one visitor may send).
  for (const [over, code] of bad) {
    assert.throws(
      () => s.bookings.hold(car(over)),
      (err) => err.status === 400 && err.code === code && err.message.length > 5,
      JSON.stringify(over)
    );
  }
  assert.throws(() => s.bookings.hold(bike({ zone: 5 })), (err) => err.code === 'invalid_zone', 'bikes have zones 0 to 4');
  assert.equal(s.store.bookings.length, 0, 'refused requests leave nothing behind');
});

test('a named bay wins over a zone, and bays are not case sensitive', async (t) => {
  const s = await site(t);
  const r = await s.post('/api/bookings', car({ bay: 'c010', zone: 99 }));
  assert.equal(r.status, 201);
  assert.equal(r.json.booking.bay, 'C010');
});

test('vehicle numbers are accepted however they are typed and stored tidy', async (t) => {
  const s = await site(t);
  const plates = ['mp09ab1234', 'MP 09 AB 1234 ', 'mp-09-ab-1234', 'KA011234', 'DL1CAB1234'];
  const seen = [];
  for (const [i, plate] of plates.entries()) {
    const r = await s.post('/api/bookings', car({ plate, hours: 1, time: `1${i}:00` }));
    assert.equal(r.status, 201, `${plate}: ${r.text}`);
    seen.push(r.json.booking.plate);
  }
  assert.deepEqual(seen, ['MP 09 AB 1234', 'MP 09 AB 1234', 'MP 09 AB 1234', 'KA 01 1234', 'DL 1 CAB 1234']);
  assert.ok(s.store.bookings.every((b) => /^[A-Z0-9]+$/.test(b.plate)), 'stored without spaces or dashes');
});

test('start times: now is allowed, a recent start is allowed for 15 minutes, a week ahead is the limit', async (t) => {
  const s = await site(t);
  assert.equal((await s.post('/api/bookings', car({ plate: 'MP09AB0001', time: '10:00' }))).status, 201, 'starting right now');
  assert.equal((await s.post('/api/bookings', car({ plate: 'MP09AB0002', date: '2026-10-21', time: '10:00' }))).status, 201, 'exactly seven days ahead');
  assert.equal((await s.post('/api/bookings', car({ plate: 'MP09AB0003', date: '2026-10-21', time: '10:30' }))).json.error, 'too_late');
  s.advance(10 * MINUTE); // 10:10
  assert.equal((await s.post('/api/bookings', car({ plate: 'MP09AB0004', time: '10:00' }))).status, 201, 'a slot that started 10 minutes ago');
  s.advance(10 * MINUTE); // 10:20
  assert.equal((await s.post('/api/bookings', car({ plate: 'MP09AB0005', time: '10:00' }))).json.error, 'too_early', 'a slot that started 20 minutes ago');
});

test('unreadable or oversized requests are refused politely', async (t) => {
  const s = await site(t);
  const json = { 'content-type': 'application/json' };
  const broken = await s.post('/api/bookings', undefined, { raw: '{oops', headers: json });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error, 'bad_json');
  const huge = await s.post('/api/bookings', undefined, { raw: JSON.stringify({ pad: 'x'.repeat(20000) }), headers: json });
  assert.equal(huge.status, 413);
  const notJson = await s.post('/api/bookings', undefined, { raw: 'vehicle=car', headers: { 'content-type': 'text/plain' } });
  assert.equal(notJson.status, 400);
  const array = await s.post('/api/bookings', []);
  assert.equal(array.status, 400);
  assert.equal(s.store.bookings.length, 0);
});

// ===== Bays and clashes =================================================================================

test('bays: overlaps are refused, back-to-back bookings are fine, and a vehicle cannot be in two places', async (t) => {
  const s = await site(t);
  const first = await bookAndPay(s, car({ bay: 'C001', plate: 'MP09AB1111', time: '11:00', hours: 2 })); // 11:00 to 13:00
  assert.equal(first.paid.status, 200);

  const overlap = await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB2222', time: '12:00', hours: 2 }));
  assert.equal(overlap.status, 409);
  assert.equal(overlap.json.error, 'bay_taken');

  const startsWhenFirstEnds = await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB2222', time: '13:00', hours: 1 }));
  assert.equal(startsWhenFirstEnds.status, 201);
  const endsWhenFirstStarts = await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB3333', time: '10:00', hours: 1 }));
  assert.equal(endsWhenFirstStarts.status, 201);

  const sameVehicle = await s.post('/api/bookings', car({ zone: 1, plate: 'MP09AB1111', time: '12:30', hours: 1 }));
  assert.equal(sameVehicle.status, 409);
  assert.equal(sameVehicle.json.error, 'plate_busy');
  const sameNumberOtherType = await s.post('/api/bookings', bike({ zone: 1, plate: 'MP09AB1111', time: '12:00', hours: 1 }));
  assert.equal(sameNumberOtherType.json.error, 'plate_busy');

  const otherBike = await s.post('/api/bookings', bike({ bay: 'B001', plate: 'MP09AB4444', time: '11:00', hours: 2 }));
  assert.equal(otherBike.status, 201, 'a bike bay with the same number as a car bay is a different bay');
  const otherCar = await s.post('/api/bookings', car({ bay: 'C002', plate: 'MP09AB5555', time: '12:00', hours: 1 }));
  assert.equal(otherCar.status, 201);
});

for (const razorpayKeys of [false, true]) {
  test(`one vehicle can book the hour right before and right after its own booking in the same bay (${razorpayKeys ? 'Razorpay' : 'demo'} mode)`, async (t) => {
    const s = await site(t, { razorpayKeys });
    const first = await bookAndPay(s, car({ bay: 'C001', time: '11:00', hours: 1 }), 'pay_1');
    assert.equal(first.paid.status, 200);
    const after = await bookAndPay(s, car({ bay: 'C001', time: '12:00', hours: 1 }), 'pay_2');
    assert.equal(after.created.status, 201, 'an extension that starts exactly when the first booking ends');
    assert.equal(after.paid.status, 200, 'and it can be paid');
    const before = await bookAndPay(s, car({ bay: 'C001', time: '10:00', hours: 1 }), 'pay_3');
    assert.equal(before.paid.status, 200, 'one that ends exactly when the first booking starts');
    const list = (await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings;
    assert.deepEqual(list.map((b) => b.window), [
      'Wed 14 Oct, 10:00 am – 11:00 am',
      'Wed 14 Oct, 11:00 am – 12:00 pm',
      'Wed 14 Oct, 12:00 pm – 1:00 pm',
    ]);
    const overlap = await s.post('/api/bookings', car({ bay: 'C002', time: '12:30', hours: 1 }));
    assert.equal(overlap.json.error, 'plate_busy', 'overlapping by even half an hour is refused');
  });
}

test('a held bay stays blocked until the hold runs out', async (t) => {
  const s = await site(t);
  assert.equal((await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB1111' }))).status, 201);
  assert.equal((await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB2222' }))).json.error, 'bay_taken');
  s.advance(9 * MINUTE);
  assert.equal((await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB2222' }))).json.error, 'bay_taken', 'still held after 9 minutes');
  s.advance(2 * MINUTE);
  assert.equal((await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB2222' }))).status, 201, 'free after 11 minutes');
});

test('an unpaid hold does not stop the same vehicle trying again, but a paid booking does', async (t) => {
  const s = await site(t);
  const first = await s.post('/api/bookings', car({ zone: 0 }));
  const second = await s.post('/api/bookings', car({ zone: 1 }));
  assert.equal(second.status, 201);
  assert.equal(s.store.get(first.json.booking.id).status, 'cancelled', 'the earlier attempt is replaced');
  assert.equal(s.store.get(second.json.booking.id).status, 'pending');
  const av = await s.get(AVAILABILITY_URL());
  assert.deepEqual(av.json.taken, [second.json.booking.bay], 'only the newer hold blocks a bay');

  const paid = await s.post('/api/payments/demo-confirm', { bookingId: second.json.booking.id });
  assert.equal(paid.status, 200);
  assert.equal((await s.post('/api/bookings', car({ zone: 2 }))).json.error, 'plate_busy');
});

test('asking for a zone gives the lowest free bay in it, and a full zone is reported', async (t) => {
  const s = await site(t);
  const a = await s.post('/api/bookings', car({ zone: 1, plate: 'MP09AB1111' }));
  const b = await s.post('/api/bookings', car({ zone: 1, plate: 'MP09AB2222' }));
  assert.equal(a.json.booking.bay, 'C051');
  assert.equal(b.json.booking.bay, 'C052');
  assert.equal(b.json.booking.zone, 'Level 2');
  const bk = await s.post('/api/bookings', bike({ zone: 4, plate: 'MP09AB3333' }));
  assert.equal(bk.json.booking.bay, 'B201');
  assert.equal(bk.json.booking.zone, 'Zone E');

  // Fill Level 4 (bays 151 to 200) directly, so the test does not run into the per-visitor rate limit.
  for (let i = 0; i < 50; i++) s.bookings.hold(car({ zone: 3, plate: `MP09AB${3000 + i}` }));
  const full = await s.post('/api/bookings', car({ zone: 3, plate: 'MP09AB9999' }));
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'zone_full');
  const av = await s.get(AVAILABILITY_URL());
  assert.equal(av.json.zones[3].free, 0);
  assert.equal(av.json.zones[0].free, 50);
  assert.equal(av.json.free, 200 - 2 - 50);
  const other = await s.post('/api/bookings', car({ zone: 2, plate: 'MP09AB9998' }));
  assert.equal(other.status, 201, 'other zones are still open');
});

test('two visitors asking for the same bay at the same moment cannot both get it', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  s.fake.state.delayMs = 15;
  const [a, b] = await Promise.all([
    s.post('/api/bookings', car({ bay: 'C010', plate: 'MP09AB1111' })),
    s.post('/api/bookings', car({ bay: 'C010', plate: 'MP09AB2222' })),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(s.store.bookings.length, 1);
});

test('two visitors asking for any bay in a zone at the same moment get different bays', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  s.fake.state.delayMs = 15;
  const [a, b] = await Promise.all([
    s.post('/api/bookings', car({ zone: 0, plate: 'MP09AB1111' })),
    s.post('/api/bookings', car({ zone: 0, plate: 'MP09AB2222' })),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.json.booking.bay, b.json.booking.bay);
});

test('if Razorpay cannot create the order, no hold is left behind', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  s.fake.state.failOrders = true;
  const r = await s.post('/api/bookings', car());
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'payment_provider_error');
  assert.ok(!r.text.includes('Authentication'), 'provider details are not shown to visitors');
  assert.equal(s.store.bookings.length, 0);
  s.fake.state.failOrders = false;
  assert.equal((await s.post('/api/bookings', car())).status, 201, 'the same bay is bookable again straight away');
});

test('if the same vehicle asks again while Razorpay is slow, the older attempt is told its hold was replaced', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  s.fake.state.delayMs = 60;
  const first = s.post('/api/bookings', car({ zone: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = s.post('/api/bookings', car({ zone: 1 }));
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, 409);
  assert.equal(r1.json.error, 'hold_lost');
  assert.equal(r2.status, 201);
});

test('releasing a hold frees the bay at once, and a second release changes nothing', async (t) => {
  const s = await site(t);
  const r = await s.post('/api/bookings', car({ bay: 'C007' }));
  const id = r.json.booking.id;
  assert.equal((await s.get(AVAILABILITY_URL())).json.taken.includes('C007'), true);
  assert.equal((await s.post(`/api/bookings/${id}/release`)).status, 200);
  assert.equal(s.store.get(id).status, 'cancelled');
  assert.equal((await s.get(AVAILABILITY_URL())).json.taken.includes('C007'), false);
  assert.equal((await s.post(`/api/bookings/${id}/release`)).status, 200);
  assert.equal((await s.post('/api/bookings/bk_0000000000000000/release')).status, 200, 'an unknown id is not an error');
  assert.equal((await s.post('/api/bookings/not-an-id/release')).status, 400);
});

test('a paid booking cannot be released', async (t) => {
  const s = await site(t);
  const { created } = await bookAndPay(s, car());
  await s.post(`/api/bookings/${created.json.booking.id}/release`);
  assert.equal(s.store.get(created.json.booking.id).status, 'paid');
});

// ===== Availability ======================================================================================

test('availability counts bays for the exact time window asked about', async (t) => {
  const s = await site(t);
  let r = await s.get(AVAILABILITY_URL());
  assert.equal(r.json.total, 200);
  assert.equal(r.json.free, 200);
  assert.deepEqual(r.json.taken, []);
  assert.deepEqual(r.json.zones.map((z) => z.name), ['Level 1', 'Level 2', 'Level 3', 'Level 4']);
  assert.equal(r.json.window, 'Wed 14 Oct, 11:00 am – 1:00 pm');

  await bookAndPay(s, car({ bay: 'C001', plate: 'MP09AB1111', time: '11:00', hours: 2 })); // 11:00 to 13:00
  r = await s.get(AVAILABILITY_URL('car', '2026-10-14', '11:00', 2));
  assert.deepEqual(r.json.taken, ['C001']);
  assert.equal(r.json.free, 199);
  assert.equal(r.json.zones[0].free, 49);
  r = await s.get(AVAILABILITY_URL('car', '2026-10-14', '12:00', 2)); // overlaps
  assert.deepEqual(r.json.taken, ['C001']);
  r = await s.get(AVAILABILITY_URL('car', '2026-10-14', '13:00', 1)); // starts as the booking ends
  assert.deepEqual(r.json.taken, []);
  r = await s.get(AVAILABILITY_URL('car', '2026-10-14', '10:00', 1)); // ends as the booking starts
  assert.deepEqual(r.json.taken, []);
  r = await s.get(AVAILABILITY_URL('bike', '2026-10-14', '11:00', 2));
  assert.equal(r.json.total, 250);
  assert.equal(r.json.free, 250, 'two-wheeler bays are separate');
  assert.deepEqual(r.json.zones.map((z) => z.name), ['Zone A', 'Zone B', 'Zone C', 'Zone D', 'Zone E']);
});

test('availability counts a payment hold while it lasts and stops counting it afterwards', async (t) => {
  const s = await site(t);
  await s.post('/api/bookings', car({ bay: 'C020' }));
  assert.deepEqual((await s.get(AVAILABILITY_URL())).json.taken, ['C020']);
  s.advance(11 * MINUTE);
  assert.deepEqual((await s.get(AVAILABILITY_URL())).json.taken, []);
});

test('availability refuses nonsense and past times', async (t) => {
  const s = await site(t);
  for (const [url, code] of [
    ['/api/availability', 'invalid_vehicle'],
    ['/api/availability?vehicle=car', 'invalid_hours'],
    ['/api/availability?vehicle=car&hours=2', 'invalid_time'],
    ['/api/availability?vehicle=car&hours=2&date=2026-10-14&time=09:00', 'too_early'],
    ['/api/availability?vehicle[]=car&hours=2&date=2026-10-14&time=11:00', 'invalid_vehicle'],
  ]) {
    const r = await s.get(url);
    assert.equal(r.status, 400, url);
    assert.equal(r.json.error, code, url);
  }
});

// ===== Paying with Razorpay ===================================================================================

test('a verified payment confirms the booking', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { created, id } = await pendingOrder(s);
  const r = await pay(s, created, 'pay_ok1');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'paid');
  assert.equal(r.json.booking.status, 'paid');
  const stored = s.store.get(id);
  assert.equal(stored.status, 'paid');
  assert.equal(stored.paymentId, 'pay_ok1');
  assert.equal(stored.paidAt, s.clock.t);
  assert.equal(stored.holdUntil, null);
  assert.equal(s.fake.calls.refunds.length, 0);
  const look = await s.get('/api/bookings/lookup?plate=MP09AB1234');
  assert.equal(look.json.bookings.length, 1);
});

test('a payment with a wrong or missing signature changes nothing', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id, orderId } = await pendingOrder(s);
  const attempts = [
    { razorpay_order_id: orderId, razorpay_payment_id: 'pay_x', razorpay_signature: sign(orderId, 'pay_x', 'some_other_secret') },
    { razorpay_order_id: orderId, razorpay_payment_id: 'pay_x', razorpay_signature: sign(orderId, 'pay_y') }, // signature for a different payment
    { razorpay_order_id: orderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'deadbeef' },
    { razorpay_order_id: orderId, razorpay_payment_id: 'pay_x', razorpay_signature: sign('order_other', 'pay_x') },
  ];
  for (const body of attempts) {
    const r = await s.post('/api/payments/verify', body);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'bad_signature');
  }
  for (const body of [{}, { razorpay_order_id: orderId }, { razorpay_order_id: orderId, razorpay_payment_id: 'pay_x' }, { razorpay_order_id: 1, razorpay_payment_id: 2, razorpay_signature: 3 }, null]) {
    const r = await s.post('/api/payments/verify', body === null ? undefined : body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'invalid_payment');
  }
  assert.equal(s.store.get(id).status, 'pending');
});

test('a correctly signed payment for an order the site never made is reported, not trusted', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const r = await s.post('/api/payments/verify', {
    razorpay_order_id: 'order_unknown',
    razorpay_payment_id: 'pay_unknown',
    razorpay_signature: sign('order_unknown', 'pay_unknown'),
  });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'unknown_order');
  assert.ok(r.json.message.includes('pay_unknown'), 'the customer is given the payment id to quote');
});

test('confirming the same payment twice is safe', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { created, id } = await pendingOrder(s);
  const a = await pay(s, created, 'pay_dup');
  const b = await pay(s, created, 'pay_dup');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.json.status, 'paid');
  assert.equal(s.store.bookings.length, 1);
  assert.equal(s.store.get(id).paymentId, 'pay_dup');
  assert.equal(s.fake.calls.refunds.length, 0);
});

test('a payment that arrives after the hold ran out is accepted if the bay is still free', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { created, id } = await pendingOrder(s, { bay: 'C005' });
  s.advance(11 * MINUTE);
  const r = await pay(s, created, 'pay_late');
  assert.equal(r.status, 200);
  assert.equal(s.store.get(id).status, 'paid');
  assert.equal(s.fake.calls.refunds.length, 0);
});

test('a payment that arrives after someone else took the bay is refunded automatically', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const a = await pendingOrder(s, { bay: 'C005', plate: 'MP09AB1111' });
  s.advance(11 * MINUTE); // A's hold runs out
  const b = await pendingOrder(s, { bay: 'C005', plate: 'KA01AB2222' });
  assert.equal((await pay(s, b.created, 'pay_b')).status, 200);

  const late = await pay(s, a.created, 'pay_a');
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'slot_lost');
  assert.equal(late.json.status, 'refunded');
  assert.ok(late.json.message.includes('₹80'), late.json.message);
  assert.ok(late.json.message.includes(a.ref), 'the message quotes the reference');
  assert.equal(late.json.paymentId, undefined, 'the payment id is only shown when the refund failed');

  assert.equal(s.fake.calls.refunds.length, 1);
  assert.equal(s.fake.calls.refunds[0].paymentId, 'pay_a');
  assert.equal(s.fake.calls.refunds[0].amount, 8000);
  const stored = s.store.get(a.id);
  assert.equal(stored.status, 'refunded');
  assert.match(stored.refundId, /^rfnd_/);
  assert.equal(s.store.get(b.id).status, 'paid', 'the other customer keeps the bay');
  assert.equal((await s.get('/api/bookings/lookup?plate=MP09AB1111')).json.bookings.length, 0);

  const again = await pay(s, a.created, 'pay_a');
  assert.equal(again.status, 409);
  assert.equal(s.fake.calls.refunds.length, 1, 'repeating the confirmation does not refund twice');
});

test('if the automatic refund fails it is recorded for the operator and retried next time', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const a = await pendingOrder(s, { bay: 'C005', plate: 'MP09AB1111' });
  s.advance(11 * MINUTE);
  const b = await pendingOrder(s, { bay: 'C005', plate: 'KA01AB2222' });
  await pay(s, b.created, 'pay_b');

  s.fake.state.failRefunds = true;
  const failed = await pay(s, a.created, 'pay_a');
  assert.equal(failed.status, 409);
  assert.equal(failed.json.status, 'refund_failed');
  assert.equal(failed.json.paymentId, 'pay_a');
  assert.ok(failed.json.message.includes('pay_a'));
  assert.equal(s.store.get(a.id).status, 'refund_failed');
  assert.match(s.store.get(a.id).refundError, /Refund not possible/);
  const dash = await s.get('/api/dashboard');
  assert.equal(dash.json.attention.length, 1);
  assert.equal(dash.json.attention[0].paymentId, 'pay_a');
  assert.equal(dash.json.attention[0].status, 'refund_failed');

  s.fake.state.failRefunds = false;
  const retried = await pay(s, a.created, 'pay_a');
  assert.equal(retried.json.status, 'refunded');
  assert.equal(s.store.get(a.id).status, 'refunded');
  assert.equal(s.fake.calls.refunds.length, 2);
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 0);
});

test('a payment that arrives after the booking time is over is refunded', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const a = await pendingOrder(s, { bay: 'C005' }); // 11:00 to 13:00
  s.advance(3 * HOUR + 10 * MINUTE);
  const late = await pay(s, a.created, 'pay_a');
  assert.equal(late.status, 409);
  assert.equal(late.json.status, 'refunded');
  assert.equal(s.fake.calls.refunds.length, 1);
});

test('paying for an attempt that was replaced by a newer one from the same vehicle is refunded', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const first = await pendingOrder(s, { zone: 0 });
  const second = await pendingOrder(s, { zone: 1 });
  const late = await pay(s, first.created, 'pay_first');
  assert.equal(late.status, 409);
  assert.equal(late.json.status, 'refunded');
  assert.equal((await pay(s, second.created, 'pay_second')).status, 200);
  assert.equal(s.store.get(second.id).status, 'paid');
});

test('paying after the window was closed is accepted if the bay is free, refunded if it is not', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const a = await pendingOrder(s, { bay: 'C007', plate: 'MP09AB1111' });
  await s.post(`/api/bookings/${a.id}/release`);
  assert.equal(s.store.get(a.id).status, 'cancelled');
  assert.equal((await pay(s, a.created, 'pay_a')).status, 200, 'the bay was still free, so the customer keeps it');
  assert.equal(s.store.get(a.id).status, 'paid');

  const b = await pendingOrder(s, { bay: 'C008', plate: 'KA01AB2222' });
  await s.post(`/api/bookings/${b.id}/release`);
  const c = await pendingOrder(s, { bay: 'C008', plate: 'DL1CAB3333' });
  await pay(s, c.created, 'pay_c');
  const late = await pay(s, b.created, 'pay_b');
  assert.equal(late.status, 409);
  assert.equal(late.json.status, 'refunded');
});

// ===== Razorpay webhook =======================================================================================

test('the webhook confirms a payment even if the customer closed the page', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id, orderId } = await pendingOrder(s);
  const r = await s.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('payment.captured', orderId, 'pay_w1', 8000)));
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'paid');
  assert.equal(s.store.get(id).status, 'paid');
  assert.equal(s.store.get(id).paymentId, 'pay_w1');
});

test('the webhook also understands order.paid, and does not double-confirm after the browser did', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { created, id, orderId } = await pendingOrder(s);
  assert.equal((await pay(s, created, 'pay_w2')).status, 200);
  const r = await s.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('order.paid', orderId, 'pay_w2', 8000)));
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'paid');
  assert.equal(s.store.get(id).paymentId, 'pay_w2');
  assert.equal(s.fake.calls.refunds.length, 0);
});

test('webhooks without a valid signature are rejected', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id, orderId } = await pendingOrder(s);
  const event = webhookEvent('payment.captured', orderId, 'pay_w3', 8000);
  const good = signedWebhook(event);

  const wrongSecret = await s.post('/api/razorpay/webhook', undefined, signedWebhook(event, 'not_the_secret'));
  assert.equal(wrongSecret.status, 400);
  const noHeader = await s.post('/api/razorpay/webhook', undefined, { raw: good.raw, headers: { 'content-type': 'application/json' } });
  assert.equal(noHeader.status, 400);
  const tampered = await s.post('/api/razorpay/webhook', undefined, { raw: good.raw.replace('8000', '1'), headers: good.headers });
  assert.equal(tampered.status, 400);
  assert.equal(s.store.get(id).status, 'pending');
});

test('webhooks about other orders, other events or wrong amounts are ignored', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id, orderId } = await pendingOrder(s);
  const send = (event) => s.post('/api/razorpay/webhook', undefined, signedWebhook(event));

  const unknown = await send(webhookEvent('payment.captured', 'order_not_ours', 'pay_x', 8000));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.ignored, 'unknown_order');
  const other = await send({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_x', order_id: orderId, amount: 8000, currency: 'INR' } } } });
  assert.equal(other.status, 200);
  assert.equal(other.json.ignored, 'event');
  const wrongAmount = await send(webhookEvent('payment.captured', orderId, 'pay_x', 100));
  assert.equal(wrongAmount.status, 200);
  assert.equal(wrongAmount.json.ignored, 'amount_mismatch');
  const noPayment = await send({ event: 'payment.captured', payload: {} });
  assert.equal(noPayment.json.ignored, 'no_payment');
  assert.equal(s.store.get(id).status, 'pending');
});

test('a signed webhook that is not JSON is refused', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const raw = '{not json';
  const r = await s.post('/api/razorpay/webhook', undefined, { raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmacHex(WEBHOOK_SECRET, raw) } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad_json');
});

test('a late webhook for a bay that was given away triggers the refund', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const a = await pendingOrder(s, { bay: 'C005', plate: 'MP09AB1111' });
  s.advance(11 * MINUTE);
  const b = await pendingOrder(s, { bay: 'C005', plate: 'KA01AB2222' });
  await pay(s, b.created, 'pay_b');
  const r = await s.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('payment.captured', a.orderId, 'pay_a', 8000)));
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'refunded');
  assert.equal(s.fake.calls.refunds.length, 1);
  assert.equal(s.store.get(a.id).status, 'refunded');
});

test('the webhook address does not exist until a webhook secret is set', async (t) => {
  const s = await site(t, { razorpayKeys: true, env: { RAZORPAY_WEBHOOK_SECRET: '' } });
  const r = await s.post('/api/razorpay/webhook', undefined, signedWebhook(webhookEvent('payment.captured', 'order_x', 'pay_x'), ''));
  assert.equal(r.status, 404);
});

// ===== Finding payments the browser never reported =============================================================

test('shortly after a hold ends the site asks Razorpay once whether the order was paid', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id, orderId } = await pendingOrder(s);
  s.fake.state.payments[orderId] = [{ id: 'pay_r1', status: 'captured', amount: 8000, currency: 'INR' }];

  assert.equal(await s.bookings.reconcile(), 0, 'nothing to do while the hold is still running');
  s.advance(10 * MINUTE + 30 * 1000);
  assert.equal(await s.bookings.reconcile(), 0, 'not yet: give the normal confirmation a minute');
  assert.equal(s.fake.calls.fetchPayments.length, 0);

  s.advance(31 * 1000);
  assert.equal(await s.bookings.reconcile(), 1);
  assert.equal(s.store.get(id).status, 'paid');
  assert.equal(s.store.get(id).paymentId, 'pay_r1');
  assert.equal(await s.bookings.reconcile(), 0);
  assert.equal(s.fake.calls.fetchPayments.length, 1, 'each order is checked once');
});

test('an unpaid order is checked once and then left alone', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id, orderId } = await pendingOrder(s);
  s.fake.state.payments[orderId] = [
    { id: 'pay_f1', status: 'failed', amount: 8000, currency: 'INR' },
    { id: 'pay_f2', status: 'authorized', amount: 8000, currency: 'INR' },
    { id: 'pay_f3', status: 'captured', amount: 100, currency: 'INR' }, // wrong amount
  ];
  s.advance(12 * MINUTE);
  assert.equal(await s.bookings.reconcile(), 0);
  assert.equal(await s.bookings.reconcile(), 0);
  assert.equal(s.fake.calls.fetchPayments.length, 1);
  assert.equal(s.store.get(id).status, 'pending');
  assert.equal(s.store.get(id).reconciled, true);
  assert.equal(s.fake.calls.refunds.length, 0);
});

test('a payment found late for a bay that was given away is refunded', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const a = await pendingOrder(s, { bay: 'C005', plate: 'MP09AB1111' });
  s.advance(11 * MINUTE);
  const b = await pendingOrder(s, { bay: 'C005', plate: 'KA01AB2222' });
  await pay(s, b.created, 'pay_b');
  s.fake.state.payments[a.orderId] = [{ id: 'pay_a', status: 'captured', amount: 8000, currency: 'INR' }];
  s.advance(MINUTE);
  assert.equal(await s.bookings.reconcile(), 1);
  assert.equal(s.store.get(a.id).status, 'refunded');
  assert.equal(s.fake.calls.refunds[0].paymentId, 'pay_a');
});

test('if Razorpay cannot be reached the check is retried a few times and then dropped', async (t) => {
  const s = await site(t, { razorpayKeys: true });
  const { id } = await pendingOrder(s);
  s.advance(12 * MINUTE);
  s.fake.state.failFetch = true;
  for (let i = 0; i < 7; i++) await s.bookings.reconcile();
  assert.equal(s.fake.calls.fetchPayments.length, 5, 'five tries, then it stops asking');
  assert.equal(s.store.get(id).reconciled, true);
});

test('demo mode has nothing to check', async (t) => {
  const s = await site(t);
  await s.post('/api/bookings', car());
  s.advance(12 * MINUTE);
  assert.equal(await s.bookings.reconcile(), 0);
});

// ===== Demo mode =======================================================================================

test('demo mode: book, pay with the pretend button, look it up', async (t) => {
  const s = await site(t);
  const created = await s.post('/api/bookings', car());
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.payment, { mode: 'demo', amount: 8000, currency: 'INR' });
  const id = created.json.booking.id;
  const paid = await s.post('/api/payments/demo-confirm', { bookingId: id });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.booking.status, 'paid');
  const first = s.store.get(id).paymentId;
  assert.match(first, /^demo_/);
  const again = await s.post('/api/payments/demo-confirm', { bookingId: id });
  assert.equal(again.status, 200);
  assert.equal(s.store.get(id).paymentId, first, 'confirming twice does not make a second payment');
  assert.equal((await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings.length, 1);
});

test('demo mode: a booking whose bay was taken in the meantime is cancelled, with nothing to refund', async (t) => {
  const s = await site(t);
  const a = await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09AB1111' }));
  s.advance(11 * MINUTE);
  await bookAndPay(s, car({ bay: 'C001', plate: 'KA01AB2222' }));
  const r = await s.post('/api/payments/demo-confirm', { bookingId: a.json.booking.id });
  assert.equal(r.status, 409);
  assert.equal(r.json.status, 'cancelled');
  assert.ok(r.json.message.includes('Nothing was charged'));
  assert.equal(s.store.get(a.json.booking.id).status, 'cancelled');
});

test('the demo payment refuses unknown, malformed and real-Razorpay bookings', async (t) => {
  const s = await site(t);
  assert.equal((await s.post('/api/payments/demo-confirm', { bookingId: 'bk_0000000000000000' })).status, 404);
  assert.equal((await s.post('/api/payments/demo-confirm', { bookingId: 'nope' })).status, 400);
  assert.equal((await s.post('/api/payments/demo-confirm', {})).status, 400);
  // A booking that belongs to a real Razorpay order (from an earlier run with keys) must never be confirmed for free.
  const r = await s.post('/api/bookings', car());
  s.store.get(r.json.booking.id).orderId = 'order_real';
  const refused = await s.post('/api/payments/demo-confirm', { bookingId: r.json.booking.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'not_demo');
  assert.equal(s.store.get(r.json.booking.id).status, 'pending');
});

// ===== Looking a booking up by vehicle number ============================================================

test('lookup finds a booking by vehicle number however it is typed and shows no money details', async (t) => {
  const s = await site(t);
  const { created } = await bookAndPay(s, car({ bay: 'C051', time: '11:00', hours: 2 }));
  for (const typed of ['mp09ab1234', 'MP 09 AB 1234', 'mp-09-ab-1234', ' MP09AB1234 ']) {
    const r = await s.get(`/api/bookings/lookup?plate=${encodeURIComponent(typed)}`);
    assert.equal(r.status, 200, typed);
    assert.equal(r.json.plate, 'MP 09 AB 1234');
    assert.equal(r.json.bookings.length, 1, typed);
  }
  const r = await s.get('/api/bookings/lookup?plate=MP09AB1234');
  const [b] = r.json.bookings;
  assert.deepEqual(Object.keys(b).sort(), ['bay', 'endMs', 'hours', 'plate', 'ref', 'startMs', 'state', 'vehicle', 'vehicleLabel', 'window', 'zone']);
  assert.equal(b.ref, created.json.booking.ref);
  assert.equal(b.bay, 'C051');
  assert.equal(b.zone, 'Level 2');
  assert.equal(b.vehicleLabel, '4-wheeler');
  assert.equal(b.window, 'Wed 14 Oct, 11:00 am – 1:00 pm');
  assert.equal(b.state, 'upcoming');
  for (const secret of ['amount', 'paymentId', 'orderId', 'id', 'status']) assert.ok(!(secret in b), `${secret} must not be public`);
  assert.ok(!r.text.includes('demo_'), 'no payment ids');
});

test('lookup shows active and upcoming bookings in order, and drops them once they end', async (t) => {
  const s = await site(t);
  await bookAndPay(s, car({ bay: 'C001', time: '14:00', hours: 1 }));
  await bookAndPay(s, car({ bay: 'C002', time: '11:00', hours: 2 }));
  let list = (await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings;
  assert.deepEqual(list.map((b) => b.bay), ['C002', 'C001'], 'earliest first');
  assert.deepEqual(list.map((b) => b.state), ['upcoming', 'upcoming']);
  s.advance(90 * MINUTE); // 11:30
  list = (await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings;
  assert.deepEqual(list.map((b) => b.state), ['active', 'upcoming']);
  s.advance(2 * HOUR); // 13:30: the first has ended
  list = (await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings;
  assert.deepEqual(list.map((b) => b.bay), ['C001']);
  s.advance(2 * HOUR); // 15:30: everything has ended
  assert.deepEqual((await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings, []);
});

test('lookup ignores unpaid holds, other vehicles and bad input', async (t) => {
  const s = await site(t);
  await s.post('/api/bookings', car({ plate: 'MP09AB1111' })); // not paid
  await bookAndPay(s, car({ plate: 'KA01AB2222', zone: 1 }));
  assert.deepEqual((await s.get('/api/bookings/lookup?plate=MP09AB1111')).json.bookings, []);
  assert.deepEqual((await s.get('/api/bookings/lookup?plate=DL1CAB9999')).json.bookings, []);
  assert.equal((await s.get('/api/bookings/lookup?plate=KA01AB2222')).json.bookings.length, 1);
  for (const url of ['/api/bookings/lookup', '/api/bookings/lookup?plate=', '/api/bookings/lookup?plate=ABC', '/api/bookings/lookup?plate[a]=1']) {
    const r = await s.get(url);
    assert.equal(r.status, 400, url);
    assert.equal(r.json.error, 'invalid_plate', url);
  }
});

test('lookups are rate limited', async (t) => {
  const s = await site(t);
  let limited = null;
  for (let i = 1; i <= 25; i++) {
    const r = await s.get('/api/bookings/lookup?plate=MP09AB1234');
    if (r.status === 429) {
      limited = { at: i, retryAfter: r.headers.get('retry-after'), body: r.json };
      break;
    }
  }
  assert.ok(limited, 'a burst of lookups must be slowed down');
  assert.equal(limited.at, 21);
  assert.ok(Number(limited.retryAfter) >= 1);
  assert.equal(limited.body.error, 'rate_limited');
});

// ===== Operator dashboard =======================================================================================

test('the dashboard shows real numbers: in use, booked later, held, revenue and the hourly picture', async (t) => {
  const s = await site(t);
  await bookAndPay(s, car({ bay: 'C001', plate: 'MP09AB1111', time: '11:00', hours: 2 })); // later today, Rs 80
  await bookAndPay(s, bike({ bay: 'B001', plate: 'MP09AB2222', time: '10:00', hours: 1 })); // in use now, Rs 20
  await s.post('/api/bookings', car({ bay: 'C002', plate: 'MP09AB3333', time: '10:00', hours: 1 })); // a payment in progress

  let d = (await s.get('/api/dashboard')).json;
  assert.equal(d.operatorProtected, false);
  assert.equal(d.paymentMode, 'demo');
  assert.equal(d.lot.bike.inUse, 1);
  assert.equal(d.lot.bike.bays[0], 'u');
  assert.equal(d.lot.bike.free, 249);
  assert.equal(d.lot.car.inUse, 0);
  assert.equal(d.lot.car.laterToday, 1);
  assert.equal(d.lot.car.bays[0], 'b');
  assert.equal(d.lot.car.bays[1], 'h');
  assert.equal(d.lot.car.held, 1);
  assert.equal(d.lot.car.bays.length, 200);
  assert.equal(d.lot.bike.bays.length, 250);
  assert.equal(d.revenueToday, 100);
  assert.equal(d.paymentsToday, 2);
  assert.equal(d.lot.car.revenueToday, 80, 'money is also split by vehicle type');
  assert.equal(d.lot.bike.revenueToday, 20);
  assert.equal(d.lot.car.paymentsToday, 1);
  assert.equal(d.lot.bike.paymentsToday, 1);
  assert.equal(d.lot.car.hourly.length, 24);
  assert.equal(d.lot.car.hourly[10], 0);
  assert.equal(d.lot.car.hourly[11], 1);
  assert.equal(d.lot.car.hourly[12], 1);
  assert.equal(d.lot.car.hourly[13], 0);
  assert.equal(d.lot.bike.hourly[10], 1);
  assert.equal(d.recent.length, 2);
  assert.deepEqual(d.recent.map((r) => r.status), ['paid', 'paid']);
  assert.equal(d.recent[0].plate.length > 0, true);

  s.advance(90 * MINUTE); // 11:30
  d = (await s.get('/api/dashboard')).json;
  assert.equal(d.lot.car.inUse, 1);
  assert.equal(d.lot.car.bays[0], 'u');
  assert.equal(d.lot.car.laterToday, 0);
  assert.equal(d.lot.car.held, 0, 'the unpaid hold has run out');
  assert.equal(d.lot.bike.inUse, 0);
});

test('the dashboard asks for the operator password when one is set', async (t) => {
  const s = await site(t, { env: { OPERATOR_USER: 'boss', OPERATOR_PASSWORD: 'secret-pass' } });
  const none = await s.get('/api/dashboard');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Basic realm=/);
  for (const [u, p] of [['boss', 'wrong'], ['someone', 'secret-pass'], ['boss', ''], ['', ''], ['boss', 'secret-pas'], ['boss', 'secret-pass!']]) {
    const r = await s.get('/api/dashboard', { headers: { authorization: basic(u, p) } });
    assert.equal(r.status, 401, `${u}:${p}`);
  }
  const garbage = await s.get('/api/dashboard', { headers: { authorization: 'Basic !!!notbase64' } });
  assert.equal(garbage.status, 401);
  const bearer = await s.get('/api/dashboard', { headers: { authorization: 'Bearer secret-pass' } });
  assert.equal(bearer.status, 401);
  const ok = await s.get('/api/dashboard', { headers: { authorization: basic('boss', 'secret-pass') } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.operatorProtected, true);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.ok(!ok.text.includes('secret-pass'));
});

test('an operator password may contain a colon', async (t) => {
  const s = await site(t, { env: { OPERATOR_PASSWORD: 'pa:ss:word' } });
  const ok = await s.get('/api/dashboard', { headers: { authorization: basic('operator', 'pa:ss:word') } });
  assert.equal(ok.status, 200);
});

test('guessing the operator password is slowed down, but only wrong guesses count', async (t) => {
  const s = await site(t, { env: { OPERATOR_PASSWORD: 'secret-pass' } });
  for (let i = 0; i < 15; i++) assert.equal((await s.get('/api/dashboard')).status, 401, 'asking without a password never locks anyone out');
  assert.equal((await s.get('/api/dashboard', { headers: { authorization: basic('operator', 'secret-pass') } })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await s.get('/api/dashboard', { headers: { authorization: basic('operator', `guess${i}`) } })).status, 401);
  const blocked = await s.get('/api/dashboard', { headers: { authorization: basic('operator', 'secret-pass') } });
  assert.equal(blocked.status, 429, 'even the right password waits after ten wrong ones');
  s.advance(61 * 1000);
  assert.equal((await s.get('/api/dashboard', { headers: { authorization: basic('operator', 'secret-pass') } })).status, 200);
});

test('in production the dashboard stays off until a password is set', async (t) => {
  const s = await site(t, { razorpayKeys: true, env: { NODE_ENV: 'production' } });
  const r = await s.get('/api/dashboard');
  assert.equal(r.status, 503);
  assert.ok(r.text.includes('OPERATOR_PASSWORD'));
});

// ===== Saving and security headers =================================================================================

test('bookings are still there after the server restarts', async (t) => {
  const first = await makeSite();
  const { created } = await bookAndPay(first, car({ bay: 'C033' }));
  first.server.closeAllConnections();
  await new Promise((resolve) => first.server.close(resolve));

  const second = await makeSite({ existingDir: first.dir });
  t.after(async () => {
    await second.close();
    fs.rmSync(first.dir, { recursive: true, force: true });
  });
  const look = await second.get('/api/bookings/lookup?plate=MP09AB1234');
  assert.equal(look.json.bookings.length, 1);
  assert.equal(look.json.bookings[0].ref, created.json.booking.ref);
  assert.deepEqual((await second.get(AVAILABILITY_URL())).json.taken, ['C033'], 'the bay is still taken');
});

test('every response carries security headers, and the content security policy can be switched off', async (t) => {
  const s = await site(t);
  const r = await s.get('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('x-powered-by'), null);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/\*\.razorpay\.com/);
  assert.match(csp, /frame-src https:\/\/\*\.razorpay\.com/);
  assert.match(csp, /frame-ancestors 'none'/);

  const off = await site(t, { env: { DISABLE_CSP: '1' } });
  const r2 = await off.get('/healthz');
  assert.equal(r2.headers.get('content-security-policy'), null);
  assert.equal(r2.headers.get('x-frame-options'), 'DENY');
});

test('unknown addresses return a clean not-found', async (t) => {
  const s = await site(t);
  const api = await s.get('/api/nope');
  assert.equal(api.status, 404);
  assert.equal(api.json.error, 'not_found');
  const page = await s.get('/nope');
  assert.equal(page.status, 404);
  assert.ok(page.text.includes('Page not found'));
  assert.equal((await s.get('/api/bookings')).status, 404);
});
