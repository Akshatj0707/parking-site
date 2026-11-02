'use strict';

// The operator cancels a paid booking from the dashboard and the full amount goes back through Razorpay.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MINUTE, makeSite, bookAndPay, car, signedWebhook, webhookEvent, AVAILABILITY_URL, basic } = require('./helpers');

const HOUR = 60 * MINUTE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PLATE = 'MP09AB1234';
const FIND = (plate = PLATE) => `/api/dashboard/bookings?plate=${plate}`;
const CANCEL = (ref) => `/api/dashboard/bookings/${ref}/cancel`;

async function site(t, options = { razorpayKeys: true }) {
  const s = await makeSite(options);
  t.after(() => s.close());
  return s;
}

// Books and pays 11:00 to 13:00 today (₹80 for a car on a weekday). Returns the booking reference.
async function paidBooking(s, over = {}, paymentId = 'pay_test1') {
  const { created, paid } = await bookAndPay(s, car(over), paymentId);
  assert.equal(created.status, 201, created.text);
  assert.equal(paid.status, 200, paid.text);
  return created.json.booking.ref;
}

const byRef = (s, ref) => s.store.bookings.find((b) => b.ref === ref);
const bayIsFree = async (s, bay) => !(await s.get(AVAILABILITY_URL())).json.taken.includes(bay);

// ===== Cancelling ==================================================================================

test('cancelling a paid booking refunds the full amount, frees the bay and takes it out of the figures', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  assert.equal(byRef(s, ref).bay, 'C001');

  const before = (await s.get('/api/dashboard')).json;
  assert.equal(before.revenueToday, 80);
  assert.equal(before.paymentsToday, 1);

  const found = await s.get(FIND());
  assert.equal(found.status, 200);
  assert.equal(found.json.plate, 'MP 09 AB 1234');
  assert.equal(found.json.bookings.length, 1);
  const row = found.json.bookings[0];
  assert.equal(row.ref, ref);
  assert.equal(row.bay, 'C001');
  assert.equal(row.amount, 80);
  assert.equal(row.paymentId, 'pay_test1');
  assert.equal(row.state, 'upcoming');
  assert.equal(row.canCancel, true);

  const done = await s.post(CANCEL(ref), {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.ok, true);
  assert.equal(done.json.outcome, 'refunded');
  assert.match(done.json.message, /^Cancelled\. ₹80 is on its way back/);
  assert.equal(done.json.booking.status, 'refunded');
  assert.equal(done.json.booking.cancelledByOperator, true);

  // Razorpay was asked for the whole payment, once, with the operator as the reason.
  assert.equal(s.fake.calls.refunds.length, 1);
  assert.deepEqual(s.fake.calls.refunds[0], {
    paymentId: 'pay_test1',
    amount: 8000,
    speed: 'normal',
    notes: { booking_ref: ref, reason: 'Cancelled by the parking operator' },
  });

  const b = byRef(s, ref);
  assert.equal(b.status, 'refunded');
  assert.equal(b.cancelReason, 'operator');
  assert.ok(b.refundId && b.refundedAt && b.cancelledAt);

  // The customer no longer has the booking, and the bay and the vehicle number are free again.
  assert.deepEqual((await s.get(`/api/bookings/lookup?plate=${PLATE}`)).json.bookings, []);
  assert.equal(await bayIsFree(s, 'C001'), true);
  const again = await bookAndPay(s, car({ bay: 'C001' }), 'pay_test2');
  assert.equal(again.created.status, 201, 'the same vehicle can book the same bay again');
  assert.equal(again.paid.status, 200);

  // The money figures no longer count it, and the recent list says what happened.
  const after = (await s.get('/api/dashboard')).json;
  assert.equal(after.revenueToday, 80, 'only the new booking counts');
  const cancelled = after.recent.find((r) => r.ref === ref);
  assert.equal(cancelled.status, 'refunded');
  assert.equal(cancelled.cancelledByOperator, true);
  assert.equal(cancelled.canCancel, false);
});

test('the cancelled state is written to the bookings file', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  assert.equal((await s.post(CANCEL(ref), {})).status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'bookings.json'), 'utf8')).bookings.find((b) => b.ref === ref);
  assert.equal(saved.status, 'refunded');
  assert.equal(saved.cancelReason, 'operator');
});

test('a booking that is on right now can be cancelled too', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.advance(HOUR + 30 * MINUTE); // 11:30, the booking runs 11:00 to 13:00
  const row = (await s.get(FIND())).json.bookings[0];
  assert.equal(row.state, 'active');
  assert.equal(row.canCancel, true);
  assert.equal((await s.post(CANCEL(ref), {})).status, 200);
  assert.equal(byRef(s, ref).status, 'refunded');
});

test('a reference typed in lower case works', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  assert.equal((await s.post(CANCEL(ref.toLowerCase()), {})).status, 200);
});

test('pressing the button twice sends one refund and tells the second press a refund is on its way', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.fake.state.refundDelayMs = 150;

  const first = s.post(CANCEL(ref), {});
  await sleep(40);
  const second = await s.post(CANCEL(ref), {});
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'refund_in_progress');

  const peek = (await s.get(FIND())).json.bookings[0];
  assert.equal(peek.status, 'refund_pending');
  assert.equal(peek.canCancel, false);

  assert.equal((await first).status, 200);
  assert.equal(s.fake.calls.refunds.length, 1, 'Razorpay was asked only once');
});

test('two presses at the same moment still send one refund', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.fake.state.refundDelayMs = 80;
  const results = await Promise.all([s.post(CANCEL(ref), {}), s.post(CANCEL(ref), {}), s.post(CANCEL(ref), {})]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(s.fake.calls.refunds.length, 1);
});

test('cancelling twice is refused the second time', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  assert.equal((await s.post(CANCEL(ref), {})).status, 200);
  const again = await s.post(CANCEL(ref), {});
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_refunded');
  assert.equal(s.fake.calls.refunds.length, 1);
});

// ===== What cannot be cancelled ======================================================================

test('only paid bookings can be cancelled: an unpaid hold, an ended booking and an unknown reference are refused', async (t) => {
  const s = await site(t);

  // An unpaid hold has nothing to refund.
  const held = await s.post('/api/bookings', car({ plate: 'MP09CD5678', bay: 'C010' }));
  assert.equal(held.status, 201);
  const heldRef = held.json.booking.ref;
  const r1 = await s.post(CANCEL(heldRef), {});
  assert.equal(r1.status, 409);
  assert.equal(r1.json.error, 'not_cancellable');
  assert.match(r1.json.message, /never paid/);
  assert.equal(byRef(s, heldRef).status, 'pending', 'the hold is untouched');
  assert.deepEqual((await s.get(FIND('MP09CD5678'))).json.bookings, [], 'an unpaid hold is not listed');

  // A booking that has ended cannot be cancelled here (and is not listed).
  const ref = await paidBooking(s);
  s.advance(4 * HOUR); // 14:00, after 13:00
  assert.deepEqual((await s.get(FIND())).json.bookings, []);
  const r2 = await s.post(CANCEL(ref), {});
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error, 'not_cancellable');
  assert.match(r2.json.message, /already ended/);
  assert.equal(byRef(s, ref).status, 'paid');

  // Unknown or badly formed references.
  const r3 = await s.post(CANCEL('ZZZZZZZZ'), {});
  assert.equal(r3.status, 404);
  assert.equal(r3.json.error, 'unknown_booking');
  assert.equal((await s.post(CANCEL('abc'), {})).status, 400);
  assert.equal((await s.post(CANCEL('bad%20ref!'), {})).status, 400);

  assert.equal(s.fake.calls.refunds.length, 0, 'no refund was ever sent');
});

test('a booking that was already refunded because its bay was lost cannot be cancelled again', async (t) => {
  const s = await site(t);
  // Someone else takes the bay while the first customer's hold runs out, and the late payment is refunded.
  const first = await s.post('/api/bookings', car({ bay: 'C001' }));
  s.advance(11 * MINUTE);
  const second = await bookAndPay(s, car({ plate: 'MP09CD5678', bay: 'C001' }), 'pay_test2');
  assert.equal(second.paid.status, 200);
  const orderId = first.json.payment.orderId;
  await s.post('/api/payments/verify', {
    razorpay_order_id: orderId,
    razorpay_payment_id: 'pay_late',
    razorpay_signature: require('./helpers').sign(orderId, 'pay_late'),
  });
  const lost = byRef(s, first.json.booking.ref);
  assert.equal(lost.status, 'refunded');
  const r = await s.post(CANCEL(lost.ref), {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'already_refunded');
});

test('looking up bad vehicle numbers is refused', async (t) => {
  const s = await site(t);
  assert.equal((await s.get('/api/dashboard/bookings')).status, 400);
  assert.equal((await s.get(FIND('hello'))).status, 400);
  assert.equal((await s.get(FIND('MP09AB1234'))).status, 200);
  assert.equal((await s.get(FIND('mp-09 ab 1234'))).status, 200, 'typed any way, like the public search');
});

test('only POST cancels: a plain link cannot', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  assert.equal((await s.get(CANCEL(ref))).status, 404);
  assert.equal(byRef(s, ref).status, 'paid');
});

// ===== When Razorpay does not cooperate ================================================================

test('if the refund fails, the booking is still cancelled, the bay is free, and the operator can try again', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.fake.state.failRefunds = true;

  const failed = await s.post(CANCEL(ref), {});
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error, 'refund_failed');
  assert.match(failed.json.message, /did not accept the refund/);
  assert.match(failed.json.message, /Refund not possible right now/);
  assert.match(failed.json.message, /cancelled and its bay is free/);
  assert.match(failed.json.message, /Needs attention/);
  assert.equal(failed.json.booking.status, 'refund_failed');

  // The bay is free and the customer's lookup is empty, but the operator can still see it and act on it.
  assert.equal(await bayIsFree(s, 'C001'), true);
  assert.deepEqual((await s.get(`/api/bookings/lookup?plate=${PLATE}`)).json.bookings, []);
  const dash = (await s.get('/api/dashboard')).json;
  assert.equal(dash.attention.length, 1);
  assert.equal(dash.attention[0].ref, ref);
  assert.equal(dash.attention[0].canCancel, true);
  assert.match(dash.attention[0].refundError, /Refund not possible right now/);
  assert.equal(dash.revenueToday, 0, 'not counted as income any more');
  const listed = (await s.get(FIND())).json.bookings;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'refund_failed');
  assert.equal(listed[0].canCancel, true);

  // Try again once Razorpay is back.
  s.fake.state.failRefunds = false;
  const retried = await s.post(CANCEL(ref), {});
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.outcome, 'refunded');
  assert.match(retried.json.message, /^Cancelled\. ₹80 is on its way back/);
  assert.equal(byRef(s, ref).status, 'refunded');
  assert.equal(byRef(s, ref).refundError, null);
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 0);
  assert.equal(s.fake.calls.refunds.length, 2, 'one failed attempt and one that worked');
  assert.equal(s.fake.calls.refunds[1].notes.reason, 'Cancelled by the parking operator');
});

test('if the operator already refunded the payment by hand in Razorpay, cancelling just clears it', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.fake.state.fullyRefunded.add('pay_test1'); // refunded in the Razorpay dashboard

  const done = await s.post(CANCEL(ref), {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.outcome, 'refunded');
  assert.match(done.json.message, /already refunded in full/);
  assert.equal(byRef(s, ref).status, 'refunded');
  assert.equal(byRef(s, ref).refundError, null);
  assert.deepEqual(s.fake.calls.fetchedPayments, ['pay_test1'], 'Razorpay was asked about the payment');
  assert.equal(await bayIsFree(s, 'C001'), true);
});

test('a refund that failed earlier clears itself on retry if the money has meanwhile been sent back by hand', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.fake.state.failRefunds = true;
  assert.equal((await s.post(CANCEL(ref), {})).status, 502);
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 1);

  // The operator refunds it by hand, then presses "Retry refund".
  s.fake.state.failRefunds = false;
  s.fake.state.fullyRefunded.add('pay_test1');
  const retried = await s.post(CANCEL(ref), {});
  assert.equal(retried.status, 200, retried.text);
  assert.match(retried.json.message, /already refunded in full/);
  assert.equal(byRef(s, ref).status, 'refunded');
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 0);
});

test('if Razorpay cannot even say whether the payment was refunded, the booking stays on the attention list', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  s.fake.state.failRefunds = true;
  s.fake.state.failPaymentFetch = true;
  const failed = await s.post(CANCEL(ref), {});
  assert.equal(failed.status, 502);
  assert.equal(byRef(s, ref).status, 'refund_failed');
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 1);
});

test('retrying a refund that failed because a bay was lost says so, and does not claim the operator cancelled it', async (t) => {
  const s = await site(t);
  const first = await s.post('/api/bookings', car({ bay: 'C001' }));
  s.advance(11 * MINUTE);
  assert.equal((await bookAndPay(s, car({ plate: 'MP09CD5678', bay: 'C001' }), 'pay_test2')).paid.status, 200);
  s.fake.state.failRefunds = true;
  const orderId = first.json.payment.orderId;
  const late = await s.post('/api/payments/verify', {
    razorpay_order_id: orderId,
    razorpay_payment_id: 'pay_late',
    razorpay_signature: require('./helpers').sign(orderId, 'pay_late'),
  });
  assert.equal(late.json.status, 'refund_failed');
  const ref = first.json.booking.ref;
  assert.equal(byRef(s, ref).status, 'refund_failed');

  s.fake.state.failRefunds = false;
  const retried = await s.post(CANCEL(ref), {});
  assert.equal(retried.status, 200, retried.text);
  assert.match(retried.json.message, /^Refund sent\./);
  assert.equal(retried.json.booking.cancelledByOperator, false);
  const last = s.fake.calls.refunds[s.fake.calls.refunds.length - 1];
  assert.equal(last.paymentId, 'pay_late');
  assert.equal(last.notes.reason, 'Parking time no longer available');
});

test('a payment confirmation that turns up after the operator cancelled does not bring the booking back', async (t) => {
  const s = await site(t);
  const created = await s.post('/api/bookings', car());
  const orderId = created.json.payment.orderId;
  const ref = created.json.booking.ref;
  const paid = await s.post('/api/payments/verify', {
    razorpay_order_id: orderId,
    razorpay_payment_id: 'pay_test1',
    razorpay_signature: require('./helpers').sign(orderId, 'pay_test1'),
  });
  assert.equal(paid.status, 200);
  assert.equal((await s.post(CANCEL(ref), {})).status, 200);

  // Razorpay's webhook for the same payment arrives late.
  const hook = signedWebhook(webhookEvent('payment.captured', orderId, 'pay_test1'));
  const res = await s.post('/api/razorpay/webhook', undefined, { raw: hook.raw, headers: hook.headers });
  assert.equal(res.status, 200);
  assert.equal(byRef(s, ref).status, 'refunded');
  assert.equal(s.fake.calls.refunds.length, 1);
  assert.equal(await bayIsFree(s, 'C001'), true);
});

// ===== Demo bookings and missing keys ====================================================================

test('in demo mode cancelling just cancels: no money moved, nothing to refund', async (t) => {
  const s = await site(t, {});
  const ref = await paidBooking(s);
  assert.match(byRef(s, ref).paymentId, /^demo_/);
  const done = await s.post(CANCEL(ref), {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.outcome, 'cancelled');
  assert.match(done.json.message, /test booking/);
  assert.equal(byRef(s, ref).status, 'cancelled');
  assert.equal(byRef(s, ref).cancelReason, 'operator');
  assert.equal(await bayIsFree(s, 'C001'), true);
  assert.deepEqual((await s.get(`/api/bookings/lookup?plate=${PLATE}`)).json.bookings, []);
  const dash = (await s.get('/api/dashboard')).json;
  assert.equal(dash.recent.find((r) => r.ref === ref).cancelledByOperator, true);
  assert.equal((await s.post(CANCEL(ref), {})).json.error, 'already_cancelled');
});

test('a demo booking left over from before the Razorpay keys were added is cancelled without asking Razorpay', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-op-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const demo = await makeSite({ existingDir: dir });
  const ref = await paidBooking(demo);
  await demo.close();

  const real = await makeSite({ existingDir: dir, razorpayKeys: true });
  t.after(() => real.close());
  const done = await real.post(CANCEL(ref), {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.outcome, 'cancelled');
  assert.equal(real.fake.calls.refunds.length, 0, 'a pretend payment cannot be refunded at Razorpay');
});

test('a real payment cannot be cancelled while the server has no Razorpay keys, and nothing changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-op-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const real = await makeSite({ existingDir: dir, razorpayKeys: true });
  const ref = await paidBooking(real);
  await real.close();

  const keyless = await makeSite({ existingDir: dir }); // the keys were removed from the settings
  t.after(() => keyless.close());
  const r = await keyless.post(CANCEL(ref), {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'payments_unavailable');
  assert.equal(byRef(keyless, ref).status, 'paid', 'the booking is exactly as it was');
});

// ===== Who may do this ===================================================================================

test('the operator password is required, and a wrong request changes nothing', async (t) => {
  const s = await site(t, { razorpayKeys: true, env: { OPERATOR_PASSWORD: 'correct horse' } });
  const ref = await paidBooking(s);
  const good = { authorization: basic('operator', 'correct horse') };

  for (const headers of [{}, { authorization: basic('operator', 'nope') }, { authorization: basic('someone', 'correct horse') }]) {
    const find = await s.get(FIND(), { headers });
    assert.equal(find.status, 401);
    const cancel = await s.post(CANCEL(ref), {}, { headers });
    assert.equal(cancel.status, 401);
    assert.match(cancel.headers.get('www-authenticate'), /^Basic/);
  }
  assert.equal(byRef(s, ref).status, 'paid');
  assert.equal(s.fake.calls.refunds.length, 0);

  assert.equal((await s.get(FIND(), { headers: good })).json.bookings.length, 1);
  assert.equal((await s.post(CANCEL(ref), {}, { headers: good })).status, 200);
});

test('in production the cancel buttons stay off until an operator password is set', async (t) => {
  const s = await site(t, { razorpayKeys: true, env: { NODE_ENV: 'production' } });
  assert.equal((await s.get(FIND())).status, 503);
  assert.equal((await s.post(CANCEL('ABCDEFGH'), {})).status, 503);
});

test('a request started by another website is refused even with the right password', async (t) => {
  const s = await site(t, { razorpayKeys: true, env: { OPERATOR_PASSWORD: 'correct horse' } });
  const auth = { authorization: basic('operator', 'correct horse') };
  const ref = await paidBooking(s);
  const ownOrigin = new URL(s.base).origin;

  const refused = [
    ['an Origin from another site', { body: {}, headers: { ...auth, origin: 'https://evil.example' } }],
    ['an Origin of "null", as sent from sandboxed pages', { body: {}, headers: { ...auth, origin: 'null' } }],
    ['a Sec-Fetch-Site of cross-site', { body: {}, headers: { ...auth, 'sec-fetch-site': 'cross-site' } }],
    ['a Sec-Fetch-Site of same-site (a sibling address)', { body: {}, headers: { ...auth, 'sec-fetch-site': 'same-site' } }],
    ['a plain-text body, which a web form can send', { raw: '{}', headers: { ...auth, 'content-type': 'text/plain' } }],
    ['a form body, which a web form can send', { raw: 'x=1', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' } }],
    ['no content type at all', { raw: '', headers: { ...auth } }],
  ];
  for (const [what, init] of refused) {
    const r = await s.post(CANCEL(ref), init.body, { raw: init.raw, headers: init.headers });
    assert.equal(r.status, 403, `${what} should be refused`);
    assert.equal(r.json.error, 'forbidden');
  }
  assert.equal(byRef(s, ref).status, 'paid', 'nothing happened');
  assert.equal(s.fake.calls.refunds.length, 0);

  // Requests the dashboard page itself makes are fine.
  const fromOwnPage = await s.post(CANCEL(ref), {}, { headers: { ...auth, origin: ownOrigin, 'sec-fetch-site': 'same-origin' } });
  assert.equal(fromOwnPage.status, 200, fromOwnPage.text);
});

test('an Origin that matches this site is accepted when the browser sends no fetch metadata', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  const r = await s.post(CANCEL(ref), {}, { headers: { origin: new URL(s.base).origin } });
  assert.equal(r.status, 200, r.text);
});

test('behind a proxy that changes the Host header, the forwarded host counts only when the proxy is trusted', async (t) => {
  const trusting = await site(t, { razorpayKeys: true, env: { TRUST_PROXY: '1' } });
  const ref1 = await paidBooking(trusting);
  const ok = await trusting.post(CANCEL(ref1), {}, { headers: { origin: 'https://parking.example.com', 'x-forwarded-host': 'parking.example.com' } });
  assert.equal(ok.status, 200, ok.text);

  const plain = await site(t, { razorpayKeys: true });
  const ref2 = await paidBooking(plain);
  const refused = await plain.post(CANCEL(ref2), {}, { headers: { origin: 'https://parking.example.com', 'x-forwarded-host': 'parking.example.com' } });
  assert.equal(refused.status, 403, 'a header anyone can set is ignored unless a proxy is trusted');
  assert.equal(byRef(plain, ref2).status, 'paid');
});

test('the operator endpoints are rate limited', async (t) => {
  const s = await site(t);
  let last;
  for (let i = 0; i < 61; i++) last = await s.get(FIND());
  assert.equal(last.status, 429);
  assert.equal(last.json.error, 'rate_limited');
});

// ===== What the public pages show ========================================================================

test('the public pages never show refund or payment details', async (t) => {
  const s = await site(t);
  const ref = await paidBooking(s);
  const look = await s.get(`/api/bookings/lookup?plate=${PLATE}`);
  for (const secret of ['pay_test1', 'paymentId', 'canCancel', 'amount', 'refund']) {
    assert.ok(!look.text.includes(secret), `the public lookup must not contain "${secret}"`);
  }
  assert.equal((await s.post(CANCEL(ref), {})).status, 200);
  const after = await s.get(`/api/bookings/lookup?plate=${PLATE}`);
  assert.deepEqual(after.json.bookings, []);
});

// ===== A restart in the middle of a refund ===============================================================

// The situation after a restart: the bookings file says "refund_pending" because the server was stopped while the
// refund request was in the air. Returns the booking reference and a new site that has read that file.
async function restartedDuringRefund(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = await makeSite({ razorpayKeys: true, existingDir: dir });
  const ref = await paidBooking(before);
  Object.assign(byRef(before, ref), { status: 'refund_pending', cancelReason: 'operator', cancelledAt: before.clock.t });
  before.store.save();
  await before.close();
  const s = await site(t, { razorpayKeys: true, existingDir: dir });
  return { s, ref, dir };
}

test('a refund that a restart cut off comes back as a failed refund, marked as interrupted', async (t) => {
  const { s, ref, dir } = await restartedDuringRefund(t);
  assert.equal(byRef(s, ref).status, 'refund_pending', 'nothing changes until the server runs its start-up step');

  assert.equal(s.bookings.recoverInterruptedRefunds(), 1);
  assert.equal(byRef(s, ref).status, 'refund_failed');
  assert.equal(byRef(s, ref).refundInterrupted, true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'bookings.json'), 'utf8')).bookings.find((b) => b.ref === ref);
  assert.equal(saved.status, 'refund_failed', 'written to the bookings file');
  assert.equal(s.bookings.recoverInterruptedRefunds(), 0, 'a second call finds nothing more');

  const dash = (await s.get('/api/dashboard')).json;
  assert.equal(dash.attention.length, 1);
  assert.equal(dash.attention[0].status, 'refund_failed');
  assert.equal(dash.attention[0].refundInterrupted, true);
  assert.equal(dash.attention[0].refundError, null, 'Razorpay never answered, so there is no Razorpay message');
  assert.equal(dash.attention[0].canCancel, true);
  const listed = (await s.get(FIND())).json.bookings;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].canCancel, true);
  assert.equal(await bayIsFree(s, 'C001'), true);
});

test('retrying an interrupted refund sends it, and the interrupted mark goes away', async (t) => {
  const { s, ref } = await restartedDuringRefund(t);
  s.bookings.recoverInterruptedRefunds();

  const retried = await s.post(CANCEL(ref), {});
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.outcome, 'refunded');
  assert.match(retried.json.message, /^Cancelled\. ₹80 is on its way back/);
  assert.equal(retried.json.booking.refundInterrupted, false);
  assert.equal(byRef(s, ref).status, 'refunded');
  assert.equal(byRef(s, ref).refundInterrupted, undefined);
  assert.equal(s.fake.calls.refunds.length, 1);
  assert.equal(s.fake.calls.refunds[0].paymentId, 'pay_test1');
  assert.equal(s.fake.calls.refunds[0].notes.reason, 'Cancelled by the parking operator');
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 0);
});

test('if the interrupted refund had in fact reached Razorpay, the retry only clears the entry', async (t) => {
  const { s, ref } = await restartedDuringRefund(t);
  s.bookings.recoverInterruptedRefunds();
  s.fake.state.fullyRefunded.add('pay_test1'); // Razorpay did get the first request

  const retried = await s.post(CANCEL(ref), {});
  assert.equal(retried.status, 200, retried.text);
  assert.match(retried.json.message, /already refunded in full/);
  assert.equal(byRef(s, ref).status, 'refunded');
  assert.equal(byRef(s, ref).refundInterrupted, undefined);
  assert.deepEqual(s.fake.calls.fetchedPayments, ['pay_test1'], 'Razorpay was asked about the payment');
  assert.equal(s.fake.state.fullyRefunded.size, 1, 'the money was not sent back a second time');
  assert.equal((await s.get('/api/dashboard')).json.attention.length, 0);
});

test('the start-up step leaves every other booking alone', async (t) => {
  const s = await site(t);
  const paid = await paidBooking(s);
  const failed = await paidBooking(s, { plate: 'MP09CD5678' }, 'pay_test2');
  s.fake.state.failRefunds = true;
  assert.equal((await s.post(CANCEL(failed), {})).status, 502);

  assert.equal(s.bookings.recoverInterruptedRefunds(), 0);
  assert.equal(byRef(s, paid).status, 'paid');
  assert.equal(byRef(s, failed).status, 'refund_failed');
  assert.equal(byRef(s, failed).refundInterrupted, undefined, 'a refund that Razorpay refused is not an interrupted one');
  assert.match(byRef(s, failed).refundError, /Refund not possible right now/);
});
