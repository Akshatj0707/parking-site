'use strict';

// What a customer can do for themselves: cancel a booking before it starts (the refund follows the cancellation rule, so it can
// be partial), and add more hours while the vehicle is parked. The clock starts at 10:00 on Wed 14 Oct 2026 (lot time).
// The default booking is 11:00 to 13:00 for a car: ₹40 an hour, so ₹80.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeSite, pay, sign, car, MINUTE, webhookEvent, signedWebhook } = require('./helpers');
const { loadConfig } = require('../src/config');

const HOUR = 60 * MINUTE;
const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const MAIL = { EMAIL_API_KEY: 'test-email-key-123', EMAIL_FROM: 'owner@example.com', EMAIL_FROM_NAME: 'Bayfind Test' };
const JSON_ASK = { accept: 'application/json' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

async function site(t, options = {}) {
  const s = await makeSite({ razorpayKeys: true, ...options, env: { ...OP, ...(options.env || {}) } });
  t.after(() => s.close());
  return s;
}

async function customer(s, name = 'Asha Verma', email = 'asha.verma@example.com') {
  const r = await s.post('/api/auth/signup', { name, email, password: 'a-good-password' });
  assert.equal(r.status, 201, r.text);
  return cookieOf(r);
}

async function admin(s) {
  const r = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}

// Books and pays for the signed-in customer. Returns { view, ref, pass, booking }.
async function paidBooking(s, cookie, over = {}, paymentId = 'pay_test1') {
  const created = await s.post('/api/bookings', car(over), cookie ? { headers: { cookie } } : undefined);
  assert.equal(created.status, 201, created.text);
  const paid = created.json.payment.mode === 'demo' ? await s.post('/api/payments/demo-confirm', { bookingId: created.json.booking.id }) : await pay(s, created, paymentId);
  assert.equal(paid.status, 200, paid.text);
  const view = paid.json.booking;
  return { view, ref: view.ref, pass: new URL('http://x' + view.pass).searchParams.get('t'), booking: s.store.bookings.find((b) => b.ref === view.ref) };
}

const cancel = (s, cookie, ref, accept, extra) => s.post(`/api/account/bookings/${ref}/cancel`, { acceptRefund: accept }, as(cookie, extra));
const mine = async (s, cookie) => (await s.get('/api/account/bookings', as(cookie))).json.bookings;
const gateOf = (s) => s.app.locals.gate;
const clockAt = (s, hh, mm) => {
  s.clock.t = Date.UTC(2026, 9, 14, hh, mm) - 330 * MINUTE; // lot time (UTC+5:30)
};

// A pretend email service that remembers what it was asked to send.
function fakeMailService() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => '' };
  };
  return { calls, fetchImpl };
}

// ===== Cancelling ===================================================================================

test('the cancellation rule comes from the settings and stays sensible', () => {
  const c = loadConfig({ DATA_DIR: '/tmp/x' });
  assert.deepEqual(c.cancel, { freeHours: 2, graceMinutes: 10, lateRefundPercent: 50 });
  assert.deepEqual(c.extend, { maxHours: 4, maxTotalHours: 8 });
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', CANCEL_LATE_REFUND_PERCENT: '250' }).cancel.lateRefundPercent, 100, 'never more than everything');
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', CANCEL_LATE_REFUND_PERCENT: 'abc' }).cancel.lateRefundPercent, 50);
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', EXTEND_MAX_HOURS: '0' }).extend.maxHours, 4);
});

test('a customer cancels a booking that starts far away: the full amount comes back, the bay is free and they get an email', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { env: MAIL, mail: { fetchImpl: mail.fetchImpl } });
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie, { time: '15:00' }); // five hours away
  const card = (await mine(s, cookie))[0];
  assert.equal(card.cancel.refundPercent, 100);
  assert.equal(card.cancel.refundAmount, 80);
  assert.equal(card.cancel.viaGrace, false, 'the booking is far away, so the full refund does not depend on the fresh payment');
  assert.equal(card.cancel.freeUntil, '1:00 pm');

  const r = await cancel(s, cookie, b.ref, 80);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.outcome, 'refunded');
  assert.equal(r.json.refundAmount, 80);
  assert.match(r.json.message, /₹80/);
  assert.deepEqual(s.fake.calls.refunds.map((x) => [x.paymentId, x.amount]), [['pay_test1', 8000]]);
  assert.equal(b.booking.status, 'refunded');
  assert.equal(b.booking.cancelReason, 'customer');
  assert.equal(b.booking.refundAmountPaise, 8000);

  // the bay is free again, and the QR codes stop working
  const avail = await s.get(`/api/availability?vehicle=car&date=2026-10-14&time=15:00&hours=2`);
  assert.equal(avail.json.taken.includes(b.booking.bay), false);
  const after = (await mine(s, cookie))[0];
  assert.equal(after.state, 'refunded');
  assert.equal(after.cancelledBy, 'customer');
  assert.equal(after.refundAmount, 80);
  assert.equal('cancel' in after, false, 'a cancelled booking cannot be cancelled again');
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(b.pass))).json.gate.stage, 'void');

  // the customer is told by email, and the admin sees who cancelled
  assert.equal(mail.calls.length, 1);
  assert.equal(mail.calls[0].body.to[0].email, 'asha.verma@example.com');
  assert.match(mail.calls[0].body.subject, /You cancelled your parking booking/);
  const row = s.bookings.operatorRow(b.booking);
  assert.equal(row.cancelledByCustomer, true);
  assert.equal(row.refundAmount, 80);
});

test('cancelling late, close to the start, gives back only the part the rule allows; a fresh payment still gets everything', async (t) => {
  const s = await site(t);
  const cookie = await customer(s);
  const a = await paidBooking(s, cookie, {}, 'pay_fresh'); // paid at 10:00, starts at 11:00
  // five minutes after paying: still inside the free period
  s.advance(5 * MINUTE);
  const fresh = (await mine(s, cookie))[0].cancel;
  assert.equal(fresh.refundPercent, 100);
  assert.equal(fresh.viaGrace, true, 'only the fresh payment gives the full refund');
  assert.equal(fresh.graceUntil, '10:10 am');

  // a quarter of an hour after paying and 45 minutes before the start: the late rule
  s.advance(10 * MINUTE);
  const card = (await mine(s, cookie))[0];
  assert.equal(card.cancel.refundPercent, 50);
  assert.equal(card.cancel.refundAmount, 40);
  assert.equal(card.cancel.keepAmount, 40);
  const r = await cancel(s, cookie, a.ref, 40);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.refundPercent, 50);
  assert.deepEqual(s.fake.calls.refunds.map((x) => x.amount), [4000]);
  assert.equal(a.booking.status, 'refunded');
  assert.equal(a.booking.refundAmountPaise, 4000);
  assert.equal(a.booking.refundPercent, 50);
  assert.equal(a.booking.amountPaise, 8000, 'the booking still records what was paid');
  assert.equal((await mine(s, cookie))[0].refundAmount, 40);
  // the money pages count the part that was sent back, not the whole payment
  assert.equal(s.bookings.ownerOverview([]).refunded.allTime, 40);
});

test('the refund the customer agreed to must be the refund they get', async (t) => {
  const s = await site(t);
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie);
  s.advance(15 * MINUTE); // the free period is over: now only 40 comes back
  for (const accept of [80, undefined, 'abc', -1]) {
    const r = await cancel(s, cookie, b.ref, accept);
    assert.ok([400, 409].includes(r.status), `${accept} -> ${r.status}`);
  }
  const changed = await cancel(s, cookie, b.ref, 80);
  assert.equal(changed.status, 409);
  assert.equal(changed.json.error, 'quote_changed');
  assert.match(changed.json.message, /₹40/);
  assert.equal(b.booking.status, 'paid', 'nothing was cancelled');
  assert.equal(s.fake.calls.refunds.length, 0);
  assert.equal((await cancel(s, cookie, b.ref, 40)).status, 200);
});

test('only the customer who made the booking can cancel it, and only from a page of this site', async (t) => {
  const s = await site(t);
  const asha = await customer(s);
  const ravi = await customer(s, 'Ravi Kumar', 'ravi.kumar@example.com');
  const b = await paidBooking(s, asha, { time: '15:00' });
  assert.equal((await cancel(s, ravi, b.ref, 80)).status, 404, 'another customer finds nothing');
  assert.equal((await cancel(s, ravi, b.ref, 80)).json.error, 'unknown_booking');
  const anon = await s.post(`/api/account/bookings/${b.ref}/cancel`, { acceptRefund: 80 }, { headers: JSON_ASK });
  assert.equal(anon.status, 401);
  assert.equal((await cancel(s, await admin(s), b.ref, 80)).status, 403, 'the owner cancels from the dashboard');
  assert.equal((await cancel(s, asha, b.ref, 80, { 'sec-fetch-site': 'cross-site' })).status, 403, 'not from another website');
  assert.equal((await cancel(s, asha, 'bad ref!', 80)).status, 400);
  assert.equal(b.booking.status, 'paid');
  assert.equal(s.fake.calls.refunds.length, 0);
  assert.equal((await cancel(s, asha, b.ref, 80)).status, 200);
});

test('a booking cannot be cancelled once it has started, once the vehicle is in, or twice', async (t) => {
  const s = await site(t);
  const cookie = await customer(s);
  const started = await paidBooking(s, cookie, {}, 'pay_a');
  const inside = await paidBooking(s, cookie, { plate: 'MP09AB7777', time: '11:30', hours: 1 }, 'pay_b');

  clockAt(s, 10, 50);
  const scan = await s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor('in', started.booking) }, as(await admin(s)));
  assert.equal(scan.json.outcome, 'entered', scan.text);
  const r1 = await cancel(s, cookie, started.ref, 40);
  assert.equal(r1.status, 409);
  assert.equal(r1.json.error, 'vehicle_inside');

  clockAt(s, 11, 35); // the second booking started at 11:30 and nobody came
  const r2 = await cancel(s, cookie, inside.ref, 40);
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error, 'already_started');
  assert.equal('cancel' in (await mine(s, cookie)).find((x) => x.ref === inside.ref), false);

  const fresh = await paidBooking(s, cookie, { plate: 'MP09AB5555', time: '16:00' }, 'pay_c');
  assert.equal((await cancel(s, cookie, fresh.ref, 80)).status, 200);
  const again = await cancel(s, cookie, fresh.ref, 80);
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_cancelled');
  assert.equal(s.fake.calls.refunds.length, 1);
});

test('two quick presses on Cancel send one refund', async (t) => {
  const s = await site(t);
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie, { time: '15:00' });
  s.fake.state.refundDelayMs = 60;
  const [one, two] = await Promise.all([cancel(s, cookie, b.ref, 80), cancel(s, cookie, b.ref, 80)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(s.fake.calls.refunds.length, 1);
  assert.equal(b.booking.status, 'refunded');
});

test('when Razorpay refuses the refund the booking is still cancelled, and the owner’s retry sends the same part again', async (t) => {
  const s = await site(t);
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie);
  s.advance(15 * MINUTE);
  s.fake.state.failRefunds = true;
  const r = await cancel(s, cookie, b.ref, 40);
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'refund_failed');
  assert.match(r.json.message, /free again/);
  assert.equal(b.booking.status, 'refund_failed');
  assert.equal(b.booking.refundDuePaise, 4000);
  assert.equal(s.bookings.takenBays('car', b.booking.startMs, b.booking.endMs, s.clock.t).has(b.booking.bay), false, 'the bay is free');

  s.fake.state.failRefunds = false;
  const retry = await s.post(`/api/dashboard/bookings/${b.ref}/cancel`, {}, as(await admin(s)));
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.outcome, 'refunded');
  assert.equal(s.fake.calls.refunds.at(-1).amount, 4000, 'the part the customer was promised, not the whole payment');
  assert.equal(b.booking.refundAmountPaise, 4000);
  assert.match(retry.json.message, /₹40 /);
});

test('a rule that gives nothing back late still cancels and frees the bay', async (t) => {
  const s = await site(t, { env: { CANCEL_LATE_REFUND_PERCENT: '0' } });
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie);
  s.advance(15 * MINUTE);
  const card = (await mine(s, cookie))[0];
  assert.equal(card.cancel.refundAmount, 0);
  const r = await cancel(s, cookie, b.ref, 0);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.outcome, 'cancelled');
  assert.match(r.json.message, /nothing is refunded/);
  assert.equal(s.fake.calls.refunds.length, 0);
  assert.equal(b.booking.status, 'cancelled');
  assert.equal(b.booking.cancelReason, 'customer');
  const after = (await mine(s, cookie))[0];
  assert.equal(after.state, 'cancelled');
  assert.equal(after.cancelledBy, 'customer');
  // it is listed for the owner as a paid booking that was cancelled, not as an unpaid attempt
  assert.equal(s.bookings.allBookings({ status: 'booked' }, () => null).rows.some((x) => x.ref === b.ref), true);
});

test('with simulated payments (no Razorpay keys) the cancellation moves no money and says so', async (t) => {
  const s = await makeSite({ env: { ...OP, CUSTOMER_LOGIN_REQUIRED: 'on' } });
  t.after(() => s.close());
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie, { time: '15:00' });
  const r = await cancel(s, cookie, b.ref, 80);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.outcome, 'cancelled');
  assert.match(r.json.message, /simulated/);
  assert.equal(b.booking.status, 'cancelled');
  assert.equal(b.booking.cancelReason, 'customer');
  assert.equal((await mine(s, cookie))[0].cancelledBy, 'customer');
});

// ===== Adding more hours ===========================================================================

// A paid 11:00 to 13:00 booking whose vehicle was scanned in at 10:50. Returns what paidBooking does.
async function parked(s, over = {}, who = null) {
  const cookie = who === null ? await customer(s) : who;
  const b = await paidBooking(s, cookie, over);
  clockAt(s, 10, 50);
  const scan = await s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor('in', b.booking) }, as(await admin(s)));
  assert.equal(scan.json.outcome, 'entered', scan.text);
  return { ...b, cookie };
}

const startExtend = (s, pass, hours) => s.post('/api/pass/extend/start', { t: pass, hours });
const verifyExtend = (s, pass, started, paymentId) =>
  s.post('/api/pass/extend/verify', {
    t: pass,
    razorpay_order_id: started.json.payment.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(started.json.payment.orderId, paymentId),
  });

test('a parked customer buys more hours: the booking grows, the bay stays theirs and the owner sees the extra money apart', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const info = await s.get('/api/pass?t=' + encodeURIComponent(p.pass));
  assert.deepEqual(info.json.extend.options.map((o) => [o.hours, o.amount, o.available, o.until]), [
    [1, 40, true, '2:00 pm'],
    [2, 80, true, '3:00 pm'],
    [3, 120, true, '4:00 pm'],
    [4, 160, true, '5:00 pm'],
  ]);
  assert.equal(info.json.extended, null);
  assert.equal('amountPaise' in info.json.extend.options[0], true);

  const started = await startExtend(s, p.pass, 2);
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.payment.mode, 'razorpay');
  assert.equal(started.json.payment.amount, 8000);
  assert.equal(started.json.extension.until, '3:00 pm');
  assert.equal(s.fake.calls.orders.at(-1).notes.kind, 'extension');
  assert.equal(p.booking.endMs, Date.UTC(2026, 9, 14, 7, 30), 'nothing changes until the payment is verified');

  const done = await verifyExtend(s, p.pass, started, 'pay_ext1');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'paid');
  assert.equal(p.booking.endMs, Date.UTC(2026, 9, 14, 9, 30)); // 3:00 pm lot time
  assert.equal(p.booking.hours, 4);
  assert.equal(p.booking.amountPaise, 8000, 'the booking’s own payment is not changed');
  assert.equal(p.booking.extensionPaise, 8000);
  const after = await s.get('/api/pass?t=' + encodeURIComponent(p.pass));
  assert.deepEqual(after.json.extended, { hours: 2, amount: 80 });
  assert.equal(after.json.booking.hours, 4);

  // paying again for the same payment changes nothing
  assert.equal((await verifyExtend(s, p.pass, started, 'pay_ext1')).status, 200);
  assert.equal(p.booking.hours, 4);

  // the bay is busy until 3:00 pm now, and the time 1:00 to 3:00 pm no longer counts as overstaying
  const avail = await s.get('/api/availability?vehicle=car&date=2026-10-14&time=14:00&hours=1');
  assert.equal(avail.json.taken.includes(p.booking.bay), true);
  clockAt(s, 13, 30);
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(p.pass))).json.gate.stage, 'inside');
  assert.equal(s.bookings.dashboard().gate.extraToday, 80, 'the owner sees the extra money for today');
});

test('extra time paid today shows next to the extra-time charges on the dashboard', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const started = await startExtend(s, p.pass, 1);
  await verifyExtend(s, p.pass, started, 'pay_ext2');
  const g = s.bookings.dashboard().gate;
  assert.equal(g.extraToday, 40);
  assert.equal(g.extraPaymentsToday, 1);
});

test('extra hours can only be bought while parked and before the booked end', async (t) => {
  const s = await site(t);
  const cookie = await customer(s);
  const b = await paidBooking(s, cookie);
  const other = await paidBooking(s, cookie, { plate: 'MP09AB4444', time: '11:30', hours: 1 }, 'pay_other2');
  // not scanned in yet
  const early = await startExtend(s, b.pass, 1);
  assert.equal(early.status, 409);
  assert.equal(early.json.error, 'not_extendable');
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(b.pass))).json.extend, null);

  clockAt(s, 10, 50);
  const admin1 = await admin(s);
  await s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor('in', b.booking) }, as(admin1));
  assert.equal((await startExtend(s, b.pass, 1)).status, 200);

  // choices that do not exist, and tokens that are not a pass
  assert.equal((await startExtend(s, b.pass, 0)).json.error, 'invalid_hours');
  assert.equal((await startExtend(s, b.pass, 9)).json.error, 'invalid_hours');
  assert.equal((await startExtend(s, b.pass, 'x')).json.error, 'invalid_hours');
  assert.equal((await startExtend(s, 'pass.ABCDEFGH.' + 'a'.repeat(22), 1)).status, 400);
  assert.equal((await startExtend(s, gateOf(s).tokenFor('in', b.booking), 1)).status, 400, 'an entry QR is not a pass');

  // after the booked end the time is not "extended", it is overstay
  clockAt(s, 13, 5);
  const late = await startExtend(s, b.pass, 1);
  assert.equal(late.json.error, 'not_extendable');

  // a vehicle that has been scanned out cannot buy time
  clockAt(s, 11, 20);
  await s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor('in', other.booking) }, as(admin1));
  clockAt(s, 11, 40);
  await s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor('out', other.booking) }, as(admin1));
  assert.equal((await startExtend(s, other.pass, 1)).json.error, 'not_extendable');
});

test('a booking right after on the same bay limits the extra hours, and the page says why', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const next = await paidBooking(s, await customer(s, 'Ravi Kumar', 'ravi@example.com'), { plate: 'MP09AB9999', bay: p.booking.bay, time: '14:00', hours: 1 }, 'pay_next');
  assert.equal(next.booking.bay, p.booking.bay);
  const info = (await s.get('/api/pass?t=' + encodeURIComponent(p.pass))).json.extend;
  assert.deepEqual(info.options.map((o) => [o.hours, o.available]), [[1, true], [2, false], [3, false], [4, false]]);
  assert.match(info.options[1].reason, /booked from 2:00 pm/);
  const blocked = await startExtend(s, p.pass, 2);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'not_available');
  assert.equal((await startExtend(s, p.pass, 1)).status, 200);
});

test('a booking cannot grow past the longest allowed stay', async (t) => {
  const s = await site(t, { env: { EXTEND_MAX_TOTAL_HOURS: '3', EXTEND_MAX_HOURS: '2' } });
  const p = await parked(s);
  const info = (await s.get('/api/pass?t=' + encodeURIComponent(p.pass))).json.extend;
  assert.deepEqual(info.options.map((o) => o.hours), [1]);
  await verifyExtend(s, p.pass, await startExtend(s, p.pass, 1), 'pay_ext3');
  const full = (await s.get('/api/pass?t=' + encodeURIComponent(p.pass))).json.extend;
  assert.equal(full.atMaximum, true);
  const r = await startExtend(s, p.pass, 1);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'at_maximum');
});

test('a payment for more time must carry a real signature for that order', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const started = await startExtend(s, p.pass, 1);
  const orderId = started.json.payment.orderId;
  const bad = await s.post('/api/pass/extend/verify', { t: p.pass, razorpay_order_id: orderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'f'.repeat(64) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_signature');
  const wrongOrder = await s.post('/api/pass/extend/verify', { t: p.pass, razorpay_order_id: 'order_other', razorpay_payment_id: 'pay_x', razorpay_signature: sign('order_other', 'pay_x') });
  assert.equal(wrongOrder.json.error, 'wrong_order');
  assert.equal(p.booking.hours, 2);
  assert.equal(p.booking.extensionPaise, undefined);
});

test('starting the same extension twice reuses its order; a failing Razorpay leaves nothing held', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const [a, b] = await Promise.all([startExtend(s, p.pass, 1), startExtend(s, p.pass, 1)]);
  assert.equal(a.json.payment.orderId, b.json.payment.orderId);
  assert.equal((await startExtend(s, p.pass, 1)).json.payment.orderId, a.json.payment.orderId);
  assert.equal(s.fake.calls.orders.filter((o) => o.notes.kind === 'extension').length, 1);
  assert.equal(p.booking.extensions.length, 1);

  const q = await parked(s, { plate: 'MP09AB3333', zone: 1 }, await customer(s, 'Ravi Kumar', 'ravi@example.com'));
  s.fake.state.failOrders = true;
  const failed = await startExtend(s, q.pass, 1);
  assert.equal(failed.status, 502);
  assert.equal((q.booking.extensions || []).length, 0, 'no attempt is left holding the bay');
});

test('the webhook and the once-a-minute check settle extra time that the customer’s browser never confirmed', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const started = await startExtend(s, p.pass, 1);
  const orderId = started.json.payment.orderId;
  const hook = signedWebhook(webhookEvent('payment.captured', orderId, 'pay_wh', 4000));
  const bad = signedWebhook(webhookEvent('payment.captured', orderId, 'pay_wh0', 9999));
  assert.equal((await s.post('/api/razorpay/webhook', undefined, { raw: bad.raw, headers: bad.headers })).json.ignored, 'amount_mismatch');
  assert.equal(p.booking.hours, 2);
  const ok = await s.post('/api/razorpay/webhook', undefined, { raw: hook.raw, headers: hook.headers });
  assert.equal(ok.json.outcome, 'extension_paid');
  assert.equal(p.booking.hours, 3);
  assert.equal((await s.post('/api/razorpay/webhook', undefined, { raw: hook.raw, headers: hook.headers })).json.outcome, 'extension_paid');
  assert.equal(p.booking.hours, 3, 'a repeated webhook adds nothing');

  // no webhook at all: the check asks Razorpay about the order a minute later
  const q = await parked(s, { plate: 'MP09AB3333', zone: 1 }, await customer(s, 'Ravi Kumar', 'ravi@example.com'));
  const second = await startExtend(s, q.pass, 2);
  s.fake.state.payments[second.json.payment.orderId] = [{ id: 'pay_rec', status: 'captured', amount: 8000, currency: 'INR' }];
  assert.equal(await s.bookings.reconcile(), 0, 'too early');
  s.advance(2 * MINUTE);
  assert.equal(await s.bookings.reconcile(), 1);
  assert.equal(q.booking.hours, 4);
  assert.equal(q.booking.extensions[0].paymentId, 'pay_rec');
});

test('while a payment for extra time is open, the bay is held for it; if it arrives too late and the bay was taken, the money goes back', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  const started = await startExtend(s, p.pass, 1); // 1:00 to 2:00 pm, held for 10 minutes
  const other = await customer(s, 'Ravi Kumar', 'ravi@example.com');
  const wanted = car({ plate: 'MP09AB8888', bay: p.booking.bay, time: '13:00', hours: 1 });
  const blocked = await s.post('/api/bookings', wanted, { headers: { cookie: other } });
  assert.equal(blocked.status, 409, 'held for the parked customer');
  assert.equal(blocked.json.error, 'bay_taken');

  s.advance(11 * MINUTE); // the hold ran out and the customer is still at the payment window
  const taken = await paidBooking(s, other, { plate: 'MP09AB8888', bay: p.booking.bay, time: '13:00', hours: 1 }, 'pay_other');
  assert.equal(taken.booking.bay, p.booking.bay);

  const late = signedWebhook(webhookEvent('payment.captured', started.json.payment.orderId, 'pay_late', 4000));
  const r = await s.post('/api/razorpay/webhook', undefined, { raw: late.raw, headers: late.headers });
  assert.equal(r.json.outcome, 'extension_refunded');
  assert.deepEqual(s.fake.calls.refunds.at(-1), { paymentId: 'pay_late', amount: 4000, speed: 'normal', notes: { booking_ref: p.ref, reason: 'Extra time no longer available' } });
  assert.equal(p.booking.hours, 2, 'the booking did not grow');
  assert.equal(p.booking.extensions[0].status, 'refunded');
  assert.equal(taken.booking.status, 'paid', 'the other customer keeps the bay');
});

test('with simulated payments extra time works with the pretend Pay button', async (t) => {
  const s = await makeSite({ env: { ...OP, CUSTOMER_LOGIN_REQUIRED: 'on' } });
  t.after(() => s.close());
  const p = await parked(s);
  const started = await startExtend(s, p.pass, 3);
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.payment.mode, 'demo');
  assert.equal((await s.post('/api/pass/extend/demo-confirm', { t: p.pass })).status, 200);
  assert.equal(p.booking.hours, 5);
  assert.equal(p.booking.extensions[0].method, 'demo');
  assert.equal((await s.post('/api/pass/extend/demo-confirm', { t: p.pass })).json.error, 'nothing_due');
});

test('the customer’s own list shows how much extra time cost', async (t) => {
  const s = await site(t);
  const p = await parked(s);
  await verifyExtend(s, p.pass, await startExtend(s, p.pass, 2), 'pay_ext9');
  const card = (await mine(s, p.cookie))[0];
  assert.equal(card.extraTimeAmount, 80);
  assert.equal(card.hours, 4);
  assert.equal(card.amount, 80, 'the first payment is still what the booking cost');
  assert.equal('cancel' in card, false, 'a parked booking cannot be cancelled');
});
