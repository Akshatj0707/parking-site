'use strict';

// The entry and exit QR codes: what a paid booking gets, what the admin's scan does, and paying for extra parking time.
// The clock starts at 10:00 on Wed 14 Oct 2026 (lot time). The booking used here is 11:00 to 13:00 for a car: ₹40 an hour.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeSite, pay, sign, car, bike, MINUTE, webhookEvent, signedWebhook, bookAndPay } = require('./helpers');
const roles = require('../src/roles');
const S = require('../public/js/shared.js');
const { Store } = require('../src/store');
const { overstayFor, stageOf, extractToken } = require('../src/gate');
const jsQR = require('../public/js/vendor/jsQR.js');

const HOUR = 60 * MINUTE;
const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const JSON_ASK = { accept: 'application/json' };
const HTML_ASK = { accept: 'text/html,application/xhtml+xml' };
const SCAN = '/api/dashboard/gate/scan';

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

async function site(t, options = {}) {
  const s = await makeSite({ razorpayKeys: true, ...options });
  t.after(() => s.close());
  return s;
}

// Books and pays 11:00 to 13:00. Returns { view, ref, pass, booking }.
async function paidBooking(s, over = {}, paymentId = 'pay_test1', headers) {
  const created = await s.post('/api/bookings', car(over), headers ? { headers } : undefined);
  assert.equal(created.status, 201, created.text);
  const paid = created.json.payment.mode === 'demo' ? await s.post('/api/payments/demo-confirm', { bookingId: created.json.booking.id }) : await pay(s, created, paymentId);
  assert.equal(paid.status, 200, paid.text);
  const view = paid.json.booking;
  return { view, ref: view.ref, pass: new URL('http://x' + view.pass).searchParams.get('t'), booking: s.store.bookings.find((b) => b.ref === view.ref) };
}

const gateOf = (s) => s.app.locals.gate;
const tokenOf = (s, kind, booking) => gateOf(s).tokenFor(kind, booking);
const scanToken = (s, kind, booking, opts) => s.post(SCAN, { token: tokenOf(s, kind, booking) }, opts);
const passInfo = (s, pass) => s.get('/api/pass?t=' + encodeURIComponent(pass));
const clockAt = (s, hh, mm) => {
  // lot time on 14 Oct 2026 (UTC+5:30)
  s.clock.t = Date.UTC(2026, 9, 14, hh, mm) - 330 * MINUTE;
};

// Turns the SVG of a QR code into pixels and reads it with jsQR, to prove that a phone could read it.
function readQr(svg) {
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
  const d = /<path d="([^"]+)"/.exec(svg)[1];
  const scale = 6;
  const w = size * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x0, y0, len] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let y = y0 * scale; y < (y0 + 1) * scale; y++) {
      for (let x = x0 * scale; x < (x0 + len) * scale; x++) {
        const i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 0;
      }
    }
  }
  const code = jsQR(px, w, w);
  return code ? code.data : null;
}

// ===== Who may scan =================================================================================

test('only the admin may scan; customers and officials may not', () => {
  assert.equal(roles.can('admin', 'gate:scan'), true);
  assert.equal(roles.can('official', 'gate:scan'), false);
  assert.equal(roles.can('customer', 'gate:scan'), false);
  assert.ok(roles.permissionsOf('admin').includes('gate:scan'));
  assert.equal(roles.matrix().permissions.find((p) => p.id === 'gate:scan').roles.join(), 'admin');
});

// ===== The pass of a paid booking ===================================================================

test('a paid booking gets a pass link; an unpaid hold and the public lookup never show one', async (t) => {
  const s = await site(t);
  const created = await s.post('/api/bookings', car());
  assert.equal(created.status, 201);
  assert.equal('pass' in created.json.booking, false, 'no pass before the payment');
  const paid = await pay(s, created);
  assert.match(paid.json.booking.pass, /^\/pass\?t=pass\.[A-Z0-9]{6,12}\.[A-Za-z0-9_-]{22}$/);

  const lookup = await s.get('/api/bookings/lookup?plate=MP09AB1234');
  assert.equal(lookup.status, 200);
  assert.equal(lookup.json.bookings.length, 1);
  assert.ok(!JSON.stringify(lookup.json).includes('pass.'), 'the lookup by vehicle number must not hand out a pass');
});

test('a signed-in customer finds the pass link and the stage of each paid booking under My bookings', async (t) => {
  const s = await site(t, { env: { CUSTOMER_LOGIN_REQUIRED: 'on' } });
  const signup = await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha.verma@example.com', password: 'a-good-password' });
  const cookie = cookieOf(signup);
  const { pass } = await paidBooking(s, {}, 'pay_test1', { cookie });
  const mine = await s.get('/api/account/bookings', as(cookie));
  assert.equal(mine.status, 200);
  assert.equal(mine.json.bookings.length, 1);
  assert.equal(mine.json.bookings[0].stage, 'upcoming');
  assert.equal(mine.json.bookings[0].pass, '/pass?t=' + pass);
});

test('the pass page opens without signing in, and the two pages have no unfilled {{TOKENS}}', async (t) => {
  const s = await site(t, { env: OP });
  const page = await s.get('/pass?t=x', { headers: HTML_ASK });
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /\{\{/);
  assert.match(page.text, /noindex/);
  const scan = await s.get('/scan', { headers: HTML_ASK, redirect: 'manual' });
  assert.equal(scan.status, 302);
  assert.match(scan.headers.get('location'), /^\/login\?next=%2Fscan/);
});

// ===== Tokens =======================================================================================

test('a token cannot be forged, borrowed from another booking or used for the wrong job', async (t) => {
  const s = await site(t);
  const a = await paidBooking(s, {}, 'pay_a');
  const b = await paidBooking(s, { plate: 'MP09CD5678', zone: 1 }, 'pay_b');
  const real = tokenOf(s, 'in', a.booking);
  assert.equal((await s.post(SCAN, { token: real })).status, 200);

  const [kind, ref, sig] = tokenOf(s, 'in', b.booking).split('.');
  const bad = [
    `${kind}.${ref}.${'A'.repeat(22)}`, // a made-up signature
    `${kind}.${a.ref}.${sig}`, // the signature of another booking
    `out.${a.ref}.${real.split('.')[2]}`, // an "in" signature on an "out" token
    'in.NOPE00.' + sig,
    'garbage',
    '',
    'in.' + a.ref,
    real + 'x',
  ];
  for (const token of bad) {
    const r = await s.post(SCAN, { token });
    assert.equal(r.status, 400, token);
    assert.equal(r.json.error, token === '' ? 'invalid_scan' : 'bad_token', token);
  }
  // a pass token is the key to the pass page, not something to scan at the gate, and the other way round
  assert.equal((await s.post(SCAN, { token: a.pass })).status, 400);
  assert.equal((await passInfo(s, real)).status, 400);
  assert.equal((await passInfo(s, a.pass)).status, 200);
});

test('a scanner may hand over the whole address in the QR code, and a token never opens another booking', async () => {
  assert.equal(extractToken('https://parking.example/scan?t=in.ABCDEF.abc'), 'in.ABCDEF.abc');
  assert.equal(extractToken('  in.ABCDEF.abc  '), 'in.ABCDEF.abc');
  assert.equal(extractToken('https://parking.example/scan'), '');
  assert.equal(extractToken('http://[bad'), '');
  assert.equal(extractToken(undefined), '');
});

test('the QR code pictures are SVG, can be read by a scanner and carry the address of the scan page', async (t) => {
  const s = await site(t);
  const a = await paidBooking(s);
  for (const kind of ['in', 'out']) {
    const r = await s.get(`/api/pass/qr?t=${encodeURIComponent(a.pass)}&k=${kind}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.text, /^<svg /);
    assert.equal(readQr(r.text), `${s.base}/scan?t=${tokenOf(s, kind, a.booking)}`);
  }
  assert.equal((await s.get(`/api/pass/qr?t=${encodeURIComponent(a.pass)}&k=pass`)).status, 400);
  assert.equal((await s.get(`/api/pass/qr?t=${encodeURIComponent(a.pass)}`)).status, 400);
  assert.equal((await s.get('/api/pass/qr?t=pass.AAAAAA.' + 'A'.repeat(22) + '&k=in')).status, 400);
});

test('PUBLIC_URL decides the address inside the QR code', async (t) => {
  const s = await site(t, { env: { PUBLIC_URL: 'https://parking.example.com/' } });
  const a = await paidBooking(s);
  const r = await s.get(`/api/pass/qr?t=${encodeURIComponent(a.pass)}&k=out`);
  assert.equal(readQr(r.text), `https://parking.example.com/scan?t=${tokenOf(s, 'out', a.booking)}`);
});

// ===== Entry ========================================================================================

test('entry: not before the early window, once only, and not after the booked time', async (t) => {
  const s = await site(t);
  const { booking } = await paidBooking(s);

  const early = await scanToken(s, 'in', booking); // 10:00, the window opens at 10:45
  assert.equal(early.status, 200);
  assert.equal(early.json.outcome, 'too_early');
  assert.equal(early.json.tone, 'warn');
  assert.match(early.json.message, /Entry opens at 10:45 am/);
  assert.equal(booking.entryAt, undefined);

  clockAt(s, 10, 50);
  const ok = await scanToken(s, 'in', booking);
  assert.equal(ok.json.outcome, 'entered');
  assert.equal(ok.json.tone, 'ok');
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.booking.plate, 'MP 09 AB 1234');
  assert.equal(ok.json.booking.bay, 'C001');
  assert.equal(ok.json.gate.stage, 'inside');
  assert.equal(booking.entryAt, s.clock.t);
  assert.equal(booking.entryBy, 'Operator');

  const entryAt = booking.entryAt;
  s.advance(5 * MINUTE);
  const again = await scanToken(s, 'in', booking);
  assert.equal(again.json.outcome, 'already_entered');
  assert.equal(again.json.tone, 'warn');
  assert.match(again.json.message, /scanned at 10:50 am/);
  assert.equal(booking.entryAt, entryAt, 'a second scan changes nothing');
});

test('entry after the booked time is refused when the vehicle never came in', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  clockAt(s, 13, 0);
  const r = await scanToken(s, 'in', booking);
  assert.equal(r.json.outcome, 'expired');
  assert.equal(r.json.tone, 'bad');
  assert.equal(r.json.ok, false);
  assert.equal(booking.entryAt, undefined);
  assert.equal((await passInfo(s, pass)).json.gate.stage, 'unused');
});

test('two scans of the same entry QR at the same moment let the vehicle in once', async (t) => {
  const s = await site(t);
  const { booking } = await paidBooking(s);
  clockAt(s, 10, 50);
  const results = await Promise.all([scanToken(s, 'in', booking), scanToken(s, 'in', booking), scanToken(s, 'in', booking)]);
  assert.deepEqual(results.map((r) => r.json.outcome).sort(), ['already_entered', 'already_entered', 'entered']);
});

test('QR_EARLY_MINUTES moves the start of the entry window', async (t) => {
  const s = await site(t, { env: { QR_EARLY_MINUTES: '60' } });
  const { booking } = await paidBooking(s);
  assert.equal((await scanToken(s, 'in', booking)).json.outcome, 'entered'); // 10:00 is exactly an hour early
});

test('a booking that is not paid, or was cancelled, cannot be scanned in', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  const cancel = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {});
  assert.equal(cancel.status, 200, cancel.text);
  clockAt(s, 10, 50);
  const r = await scanToken(s, 'in', booking);
  assert.equal(r.json.outcome, 'not_valid');
  assert.equal(r.json.tone, 'bad');
  const info = await passInfo(s, pass);
  assert.equal(info.json.gate.stage, 'void');
  assert.equal(info.json.qr, null);
  assert.equal((await s.get(`/api/pass/qr?t=${encodeURIComponent(pass)}&k=in`)).status, 404);
});

// ===== Exit =========================================================================================

test('exit needs an entry first, and inside the booked time it costs nothing extra', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  clockAt(s, 10, 50);
  const first = await scanToken(s, 'out', booking);
  assert.equal(first.json.outcome, 'not_entered');
  assert.equal(first.json.tone, 'bad');
  assert.equal(booking.exitAt, undefined);

  await scanToken(s, 'in', booking);
  clockAt(s, 12, 30);
  const out = await scanToken(s, 'out', booking);
  assert.equal(out.json.outcome, 'exited');
  assert.equal(out.json.tone, 'ok');
  assert.equal(out.json.gate.stage, 'left');
  assert.equal(booking.exitAt, s.clock.t);
  assert.equal(booking.overstay, undefined);

  const again = await scanToken(s, 'out', booking);
  assert.equal(again.json.outcome, 'already_left');
  const reuse = await scanToken(s, 'in', booking);
  assert.equal(reuse.json.outcome, 'already_left', 'a booking that has been used cannot be entered again');
  assert.equal((await passInfo(s, pass)).json.gate.stage, 'left');
});

test('leaving within the grace period after the booked end is free', async (t) => {
  const s = await site(t);
  const { booking } = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  clockAt(s, 13, 10); // exactly the grace period
  const out = await scanToken(s, 'out', booking);
  assert.equal(out.json.outcome, 'exited');
  assert.match(out.json.message, /inside the free 10 minutes/);
  assert.equal(booking.overstay, undefined);
});

test('the extra charge is worked out per started hour after the grace period, at the booking’s own rate', () => {
  const cfg = { graceMinutes: 10, earlyMinutes: 15 };
  const b = { endMs: 1_000_000_000, rate: 40, hours: 2, amountPaise: 8000 };
  const at = (minutes, extraMs = 0) => overstayFor(b, b.endMs + minutes * MINUTE + extraMs, cfg);
  assert.equal(at(-30).hours, 0);
  assert.equal(at(0).hours, 0);
  assert.equal(at(10).hours, 0);
  assert.deepEqual(at(10, 1), { hours: 1, amountPaise: 4000, overMinutes: 11 });
  assert.equal(at(60).hours, 1);
  assert.equal(at(60, 1).hours, 2);
  assert.equal(at(60, 1).amountPaise, 8000);
  assert.equal(at(185).hours, 4);
  assert.equal(at(185).amountPaise, 16000);
  assert.equal(overstayFor({ ...b, rate: 22.5 }, b.endMs + 30 * MINUTE, cfg).amountPaise, 2250);
  assert.equal(overstayFor({ ...b, rate: undefined }, b.endMs + 30 * MINUTE, cfg).amountPaise, 4000, 'an old booking without a rate uses what it paid per hour');
  assert.equal(overstayFor(b, b.endMs + 5 * MINUTE, { graceMinutes: 0 }).hours, 1);
});

test('the stages of a visit', () => {
  const cfg = { graceMinutes: 10, earlyMinutes: 15 };
  const base = { status: 'paid', startMs: 100 * MINUTE, endMs: 160 * MINUTE };
  assert.equal(stageOf({ ...base, status: 'pending' }, 0, cfg), 'void');
  assert.equal(stageOf(base, 84 * MINUTE, cfg), 'upcoming');
  assert.equal(stageOf(base, 85 * MINUTE, cfg), 'ready');
  assert.equal(stageOf(base, 160 * MINUTE, cfg), 'unused');
  assert.equal(stageOf({ ...base, entryAt: 90 * MINUTE }, 170 * MINUTE, cfg), 'inside');
  assert.equal(stageOf({ ...base, entryAt: 90 * MINUTE }, 170 * MINUTE + 1, cfg), 'overstaying');
  assert.equal(stageOf({ ...base, entryAt: 90, exitScanAt: 1, overstay: { status: 'due' } }, 0, cfg), 'payment_due');
  assert.equal(stageOf({ ...base, entryAt: 90, exitScanAt: 1, exitAt: 1, overstay: { status: 'paid' } }, 0, cfg), 'left');
});

// ===== Staying too long and paying for it ============================================================

async function overstayedBooking(s, minutesLate = 70) {
  const made = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', made.booking);
  clockAt(s, 13, 0);
  s.advance(minutesLate * MINUTE);
  const out = await scanToken(s, 'out', made.booking);
  return { ...made, out };
}

test('leaving late: the exit scan shows the extra charge and the vehicle does not leave until it is paid', async (t) => {
  const s = await site(t);
  const { booking, pass, out } = await overstayedBooking(s, 70); // 14:10, 70 minutes past 13:00
  assert.equal(out.status, 200);
  assert.equal(out.json.outcome, 'payment_due');
  assert.equal(out.json.tone, 'warn');
  assert.equal(out.json.ok, true);
  assert.match(out.json.title, /Extra ₹80/);
  assert.match(out.json.message, /70 min past the booked end: 2 extra hours at ₹40 an hour is ₹80/);
  assert.equal(out.json.gate.stage, 'payment_due');
  assert.equal(out.json.gate.overstay.amount, 80);
  assert.equal(booking.exitScanAt, s.clock.t);
  assert.equal(booking.exitAt, undefined, 'not left yet');
  assert.deepEqual({ hours: booking.overstay.hours, amountPaise: booking.overstay.amountPaise, status: booking.overstay.status }, { hours: 2, amountPaise: 8000, status: 'due' });

  // The amount is fixed at the exit scan: scanning again an hour later shows the same charge.
  s.advance(HOUR);
  const again = await scanToken(s, 'out', booking);
  assert.equal(again.json.outcome, 'payment_due');
  assert.equal(again.json.gate.overstay.amount, 80);

  const info = (await passInfo(s, pass)).json;
  assert.equal(info.gate.stage, 'payment_due');
  assert.equal(info.gate.overstay.hours, 2);
});

test('while a vehicle is inside past the booked time the pass shows what leaving now would cost', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  clockAt(s, 13, 5);
  assert.equal((await passInfo(s, pass)).json.gate.stage, 'inside');
  clockAt(s, 13, 25);
  const info = (await passInfo(s, pass)).json;
  assert.equal(info.gate.stage, 'overstaying');
  assert.deepEqual(info.gate.estimate, { hours: 1, amount: 40, overMinutes: 25 });
  assert.equal(booking.overstay, undefined, 'nothing is charged until the exit QR is scanned');
});

test('paying the extra time: one Razorpay order for the right amount, checked signature, then the vehicle is free to go', async (t) => {
  const s = await site(t);
  const { booking, pass } = await overstayedBooking(s, 70);

  const start = await s.post('/api/pass/overstay/start', { t: pass });
  assert.equal(start.status, 200, start.text);
  assert.equal(start.json.payment.mode, 'razorpay');
  assert.equal(start.json.payment.amount, 8000);
  assert.equal(start.json.payment.orderId, 'order_T0002'); // T0001 was the booking itself
  assert.match(start.json.payment.keyId, /^rzp_test_/);
  const order = s.fake.calls.orders[1];
  assert.equal(order.amount, 8000);
  assert.equal(order.currency, 'INR');
  assert.equal(order.receipt, 'ov_' + booking.id);
  assert.ok(order.receipt.length <= 40);
  assert.equal(order.notes.kind, 'overstay');
  assert.equal(order.notes.booking_ref, booking.ref);

  // Pressing Pay again (or a second phone) reuses the order instead of creating another one.
  const [second, third] = await Promise.all([s.post('/api/pass/overstay/start', { t: pass }), s.post('/api/pass/overstay/start', { t: pass })]);
  assert.equal(second.json.payment.orderId, 'order_T0002');
  assert.equal(third.json.payment.orderId, 'order_T0002');
  assert.equal(s.fake.calls.orders.length, 2);

  const orderId = start.json.payment.orderId;
  const body = (over = {}) => ({ t: pass, razorpay_order_id: orderId, razorpay_payment_id: 'pay_extra1', razorpay_signature: sign(orderId, 'pay_extra1'), ...over });

  const forged = await s.post('/api/pass/overstay/verify', body({ razorpay_signature: 'f'.repeat(64) }));
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error, 'bad_signature');
  assert.equal(booking.overstay.status, 'due');
  assert.equal(booking.exitAt, undefined);

  const wrongOrder = await s.post('/api/pass/overstay/verify', body({ razorpay_order_id: 'order_other', razorpay_signature: sign('order_other', 'pay_extra1') }));
  assert.equal(wrongOrder.status, 400);
  assert.equal(wrongOrder.json.error, 'wrong_order');

  const bookingOrder = s.fake.calls.orders[0];
  assert.ok(bookingOrder.receipt.startsWith('bk_'));
  const bookingOrderPay = await s.post('/api/pass/overstay/verify', body({ razorpay_order_id: 'order_T0001', razorpay_signature: sign('order_T0001', 'pay_extra1') }));
  assert.equal(bookingOrderPay.status, 400, 'the payment of the booking itself cannot pay the extra time');
  assert.equal(booking.overstay.status, 'due');

  const paid = await s.post('/api/pass/overstay/verify', body());
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.status, 'paid');
  assert.equal(paid.json.gate.stage, 'left');
  assert.equal(booking.overstay.status, 'paid');
  assert.equal(booking.overstay.paymentId, 'pay_extra1');
  assert.equal(booking.overstay.method, 'razorpay');
  assert.equal(booking.exitAt, booking.exitScanAt);

  // paying twice changes nothing, and nothing is left to pay
  assert.equal((await s.post('/api/pass/overstay/verify', body())).status, 200);
  const more = await s.post('/api/pass/overstay/start', { t: pass });
  assert.equal(more.status, 409);
  assert.equal(more.json.error, 'nothing_due');
  assert.equal((await scanToken(s, 'out', booking)).json.outcome, 'already_left');
  assert.equal(s.fake.calls.refunds.length, 0);

  const dash = (await s.get('/api/dashboard')).json;
  assert.deepEqual(dash.gate, { inside: 0, overstaying: 0, paymentDue: 0, released: 0, extraToday: 80, extraPaymentsToday: 1 });
  assert.equal(dash.revenueToday, 80, 'the booking money does not include the extra time');
});

test('there is nothing to pay before the exit QR was scanned, and a free exit leaves nothing to pay', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  assert.equal((await s.post('/api/pass/overstay/start', { t: pass })).status, 409);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  clockAt(s, 13, 30);
  assert.equal((await s.post('/api/pass/overstay/start', { t: pass })).status, 409, 'the charge is only worked out by the exit scan');
  assert.equal((await s.post('/api/pass/overstay/start', { t: 'bad' })).status, 400);
  assert.equal((await s.post('/api/pass/overstay/start', {})).status, 400);
});

test('if Razorpay cannot create the order the customer is told, and nothing is stored', async (t) => {
  const s = await site(t);
  const { booking, pass } = await overstayedBooking(s, 70);
  s.fake.state.failOrders = true;
  const r = await s.post('/api/pass/overstay/start', { t: pass });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'payment_provider_error');
  assert.equal(booking.overstay.orderId, undefined);
  s.fake.state.failOrders = false;
  assert.equal((await s.post('/api/pass/overstay/start', { t: pass })).status, 200);
});

test('Razorpay’s webhook settles a paid extra charge even if the customer closed the page', async (t) => {
  const s = await site(t);
  const { booking, pass } = await overstayedBooking(s, 70);
  const start = await s.post('/api/pass/overstay/start', { t: pass });
  const orderId = start.json.payment.orderId;

  // the wrong amount is ignored
  const wrong = signedWebhook(webhookEvent('payment.captured', orderId, 'pay_w1', 4000));
  const bad = await s.post('/api/razorpay/webhook', undefined, { raw: wrong.raw, headers: wrong.headers });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.ignored, 'amount_mismatch');
  assert.equal(booking.overstay.status, 'due');

  const good = signedWebhook(webhookEvent('payment.captured', orderId, 'pay_w2', 8000));
  const ok = await s.post('/api/razorpay/webhook', undefined, { raw: good.raw, headers: good.headers });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'overstay_paid');
  assert.equal(booking.overstay.status, 'paid');
  assert.equal(booking.overstay.paymentId, 'pay_w2');
  assert.ok(booking.exitAt);
  assert.equal(booking.status, 'paid', 'the booking itself stays paid and is never refunded');
  assert.equal(s.fake.calls.refunds.length, 0);

  // the same webhook again is harmless
  const again = await s.post('/api/razorpay/webhook', undefined, { raw: good.raw, headers: good.headers });
  assert.equal(again.json.outcome, 'overstay_paid');
  assert.equal(booking.overstay.paymentId, 'pay_w2');
});

test('the once-a-minute check finds an extra charge that was paid but never confirmed', async (t) => {
  const s = await site(t);
  const { booking, pass } = await overstayedBooking(s, 70);
  const start = await s.post('/api/pass/overstay/start', { t: pass });
  const orderId = start.json.payment.orderId;

  s.advance(2 * MINUTE);
  assert.equal(await s.bookings.reconcile(), 0, 'nothing was paid yet');
  assert.equal(booking.overstay.status, 'due');
  assert.deepEqual(s.fake.calls.fetchPayments, [orderId]);

  s.fake.state.payments[orderId] = [{ id: 'pay_r1', status: 'captured', amount: 8000, currency: 'INR' }];
  assert.equal(await s.bookings.reconcile(), 1);
  assert.equal(booking.overstay.status, 'paid');
  assert.equal(booking.overstay.paymentId, 'pay_r1');
  assert.ok(booking.exitAt);
});

test('demo mode (no Razorpay keys, a developer’s computer) pays the extra time with a pretend payment', async (t) => {
  const s = await site(t, { razorpayKeys: false });
  const { booking, pass } = await overstayedBooking(s, 30);
  const start = await s.post('/api/pass/overstay/start', { t: pass });
  assert.equal(start.status, 200, start.text);
  assert.deepEqual(start.json.payment, { mode: 'demo', amount: 4000, currency: 'INR' });
  assert.equal((await s.post('/api/pass/overstay/verify', { t: pass })).status, 404);
  const done = await s.post('/api/pass/overstay/demo-confirm', { t: pass });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.gate.stage, 'left');
  assert.equal(booking.overstay.method, 'demo');
});

test('OVERSTAY_GRACE_MINUTES changes the free time', async (t) => {
  const s = await site(t, { env: { OVERSTAY_GRACE_MINUTES: '0' } });
  const { out } = await overstayedBooking(s, 1);
  assert.equal(out.json.outcome, 'payment_due');
  assert.equal(out.json.gate.overstay.hours, 1);
});

// ===== The admin settles it another way ==============================================================

test('the admin can mark an extra charge as collected in cash, or drop it', async (t) => {
  const s = await site(t);
  const a = await paidBooking(s);
  const b = await paidBooking(s, { plate: 'MP09CD5678', zone: 1 }, 'pay_b');
  clockAt(s, 10, 50);
  await scanToken(s, 'in', a.booking);
  await scanToken(s, 'in', b.booking);
  clockAt(s, 14, 10);
  assert.equal((await scanToken(s, 'out', a.booking)).json.outcome, 'payment_due');
  assert.equal((await scanToken(s, 'out', b.booking)).json.outcome, 'payment_due');

  const none = await s.post('/api/dashboard/gate/settle', { ref: 'ZZZZZZ', method: 'manual' });
  assert.equal(none.status, 404);
  assert.equal((await s.post('/api/dashboard/gate/settle', { ref: a.ref, method: 'bogus' })).status, 400);

  const cash = await s.post('/api/dashboard/gate/settle', { ref: a.ref, method: 'manual' });
  assert.equal(cash.status, 200, cash.text);
  assert.equal(cash.json.outcome, 'collected');
  assert.equal(a.booking.overstay.status, 'paid');
  assert.equal(a.booking.overstay.method, 'manual');
  assert.ok(a.booking.exitAt);
  assert.equal((await s.post('/api/dashboard/gate/settle', { ref: a.ref, method: 'manual' })).status, 409, 'nothing left to settle');
  assert.equal((await s.get('/api/dashboard')).json.gate.extraToday, 80, 'cash that was collected counts');

  const waived = await s.post('/api/dashboard/gate/settle', { ref: b.ref, method: 'waive' });
  assert.equal(waived.json.outcome, 'waived');
  assert.equal(b.booking.overstay.status, 'waived');
  assert.ok(b.booking.exitAt);
  assert.equal((await s.get('/api/dashboard')).json.gate.extraToday, 80, 'a waived charge is not money received');
  assert.equal((await passInfo(s, b.pass)).json.gate.stage, 'left');
});

// ===== Typing instead of scanning ====================================================================

test('without a QR code the admin can type the booking reference or the vehicle number', async (t) => {
  const s = await site(t);
  const { booking, ref } = await paidBooking(s);
  clockAt(s, 10, 50);
  const byRef = await s.post(SCAN, { ref: ref.toLowerCase(), action: 'in' });
  assert.equal(byRef.json.outcome, 'entered');
  clockAt(s, 12, 0);
  const byPlate = await s.post(SCAN, { plate: 'mp 09 ab 1234', action: 'out' });
  assert.equal(byPlate.json.outcome, 'exited');
  assert.ok(booking.exitAt);

  assert.equal((await s.post(SCAN, { ref: 'NOPE99', action: 'in' })).status, 404);
  assert.equal((await s.post(SCAN, { plate: 'MP09ZZ9999', action: 'in' })).status, 404);
  assert.equal((await s.post(SCAN, { plate: 'nonsense', action: 'in' })).status, 400);
  assert.equal((await s.post(SCAN, { ref, action: 'sideways' })).status, 400);
  assert.equal((await s.post(SCAN, {})).status, 400);
  assert.equal((await s.post(SCAN, { ref: '../etc', action: 'in' })).status, 404);
});

test('typing a vehicle number scans in the booking that is due now, not a later one', async (t) => {
  const s = await site(t);
  const later = await paidBooking(s, { time: '16:00' }, 'pay_late');
  const now = await paidBooking(s, {}, 'pay_now');
  clockAt(s, 10, 50);
  const r = await s.post(SCAN, { plate: 'MP09AB1234', action: 'in' });
  assert.equal(r.json.outcome, 'entered');
  assert.equal(r.json.booking.ref, now.ref);
  assert.equal(later.booking.entryAt, undefined);
});

// ===== Seeing it ====================================================================================

test('who is inside, and the status of one booking', async (t) => {
  const s = await site(t);
  const a = await paidBooking(s);
  const b = await paidBooking(s, { plate: 'MP09CD5678', zone: 1 }, 'pay_b');
  clockAt(s, 10, 50);
  await scanToken(s, 'in', a.booking);
  clockAt(s, 10, 55);
  await scanToken(s, 'in', b.booking);

  let inside = (await s.get('/api/dashboard/gate/inside')).json;
  assert.equal(inside.count, 2);
  assert.deepEqual(inside.vehicles.map((v) => v.booking.ref), [a.ref, b.ref]);
  assert.ok(!JSON.stringify(inside).includes('pay_'), 'no payment ids');

  clockAt(s, 12, 0);
  await scanToken(s, 'out', a.booking);
  inside = (await s.get('/api/dashboard/gate/inside')).json;
  assert.deepEqual(inside.vehicles.map((v) => v.booking.ref), [b.ref]);

  const status = await s.get('/api/dashboard/gate/status?ref=' + a.ref);
  assert.equal(status.json.gate.stage, 'left');
  assert.equal((await s.get('/api/dashboard/gate/status?ref=NOPE99')).status, 404);

  const dash = (await s.get('/api/dashboard')).json;
  assert.equal(dash.gate.inside, 1);

  // the admin's lists show it
  const all = (await s.get('/api/dashboard/all-bookings')).json;
  const rowA = all.rows.find((r) => r.ref === a.ref);
  assert.equal(rowA.gate.stage, 'left');
  assert.equal(rowA.canCancel, false);
});

test('a vehicle that has been scanned in can no longer be cancelled and refunded', async (t) => {
  const s = await site(t);
  const { booking, ref } = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);

  const found = await s.get('/api/dashboard/bookings?plate=MP09AB1234');
  assert.equal(found.json.bookings.length, 0, 'it is not offered for cancelling');
  const r = await s.post(`/api/dashboard/bookings/${ref}/cancel`, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'vehicle_inside');
  assert.equal(booking.status, 'paid');
  assert.equal(s.fake.calls.refunds.length, 0);
});

test('a booking that was never used can still be cancelled before the vehicle comes in', async (t) => {
  const s = await site(t);
  const { ref } = await paidBooking(s);
  clockAt(s, 10, 30);
  const r = await s.post(`/api/dashboard/bookings/${ref}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'refunded');
});

test('the visit is kept when the site restarts', async (t) => {
  const s = await site(t);
  const { booking, ref } = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  const reloaded = new Store(s.dir).bookings.find((b) => b.ref === ref);
  assert.equal(reloaded.entryAt, booking.entryAt);
  assert.equal(reloaded.entryBy, 'Operator');
});

test('a bike is charged its own, lower rate', async (t) => {
  const s = await site(t);
  const created = await s.post('/api/bookings', bike());
  const paid = await pay(s, created);
  const booking = s.store.bookings.find((b) => b.ref === paid.json.booking.ref);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  clockAt(s, 14, 5);
  const out = await scanToken(s, 'out', booking);
  assert.equal(out.json.gate.overstay.amount, 40); // 2 extra hours at ₹20
});

// ===== Access control ===============================================================================

test('the scan routes and the scan page are for the signed-in admin only', async (t) => {
  const s = await site(t, { env: OP });
  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }));
  assert.ok(admin);
  const created = await bookAndPay(s, car(), 'pay_test1');
  const booking = s.store.bookings.find((b) => b.ref === created.paid.json.booking.ref);
  const token = tokenOf(s, 'in', booking);
  clockAt(s, 10, 50);

  // anyone not signed in
  const anon = await s.post(SCAN, { token }, { headers: JSON_ASK });
  assert.equal(anon.status, 401);
  assert.equal((await s.get('/api/dashboard/gate/inside', { headers: JSON_ASK })).status, 401);
  assert.equal((await s.post('/api/dashboard/gate/settle', { ref: booking.ref, method: 'waive' }, { headers: JSON_ASK })).status, 401);
  assert.equal(booking.entryAt, undefined);

  // a customer
  const customer = cookieOf(await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha.verma@example.com', password: 'a-good-password' }));
  for (const r of [await s.post(SCAN, { token }, as(customer)), await s.get('/api/dashboard/gate/inside', as(customer)), await s.get('/api/dashboard/gate/status?ref=' + booking.ref, as(customer))]) {
    assert.equal(r.status, 403, r.text);
  }
  assert.equal((await s.get('/scan', { headers: { cookie: customer, ...HTML_ASK } })).status, 403);

  // a government official: sees data but never scans
  const official = { name: 'R. K. Sharma', office: 'Municipal Corporation', email: 'rk.sharma@gov.example.in', password: 'official-pass-1' };
  assert.equal((await s.post('/api/dashboard/officials', official, as(admin))).status, 201);
  const off = cookieOf(await s.post('/api/auth/login', { identifier: official.email, password: official.password }));
  const denied = await s.post(SCAN, { token }, as(off));
  assert.equal(denied.status, 403);
  assert.match(denied.json.message, /Scan the entry and exit QR codes/);
  assert.equal((await s.get('/api/dashboard/gate/inside', as(off))).status, 403);
  assert.equal((await s.post('/api/dashboard/gate/settle', { ref: booking.ref, method: 'waive' }, as(off))).status, 403);
  const page = await s.get('/scan', { headers: { cookie: off, ...HTML_ASK } });
  assert.equal(page.status, 403);
  assert.equal(booking.entryAt, undefined, 'none of those scans changed anything');

  // the admin: the scan is recorded under the admin's name
  const page2 = await s.get('/scan', { headers: { cookie: admin, ...HTML_ASK } });
  assert.equal(page2.status, 200);
  assert.doesNotMatch(page2.text, /\{\{/);
  const ok = await s.post(SCAN, { token }, as(admin));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.outcome, 'entered');
  assert.equal(booking.entryBy, 'operator');
});

test('a scan sent from another website’s page is refused even when the admin is signed in', async (t) => {
  const s = await site(t, { env: OP });
  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }));
  const { booking } = await paidBooking(s);
  clockAt(s, 10, 50);
  const token = tokenOf(s, 'in', booking);
  const evil = await s.post(SCAN, { token }, as(admin, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
  assert.equal(booking.entryAt, undefined);
  const plain = await s.post(SCAN, undefined, { raw: JSON.stringify({ token }), headers: { cookie: admin, ...JSON_ASK, 'content-type': 'text/plain' } });
  assert.equal(plain.status, 403);
  assert.equal(booking.entryAt, undefined);
});

test('the script that scans can sign in with the operator password (HTTP Basic) and is recorded as "Operator"', async (t) => {
  const s = await site(t, { env: OP });
  const { booking } = await paidBooking(s);
  clockAt(s, 10, 50);
  const header = 'Basic ' + Buffer.from(`operator:${OP.OPERATOR_PASSWORD}`).toString('base64');
  const r = await s.post(SCAN, { token: tokenOf(s, 'in', booking) }, { headers: { authorization: header } });
  assert.equal(r.status, 200, r.text);
  assert.equal(booking.entryBy, 'Operator');
});

test('the second admin login can scan too, and is recorded by name', async (t) => {
  const s = await site(t, { env: { ...OP, EXTRA_ADMIN_EMAIL: 'second.admin@example.com', EXTRA_ADMIN_PASSWORD: 'second-admin-pass-1', EXTRA_ADMIN_NAME: 'Second Admin' } });
  const { booking } = await paidBooking(s);
  clockAt(s, 10, 50);
  const cookie = cookieOf(await s.post('/api/auth/login', { identifier: 'second.admin@example.com', password: 'second-admin-pass-1' }));
  const r = await s.post(SCAN, { token: tokenOf(s, 'in', booking) }, as(cookie));
  assert.equal(r.status, 200, r.text);
  assert.equal(booking.entryBy, 'Second Admin');
});

// ===== The pass page ================================================================================

test('the pass shows each stage of the visit', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  const stage = async () => (await passInfo(s, pass)).json.gate.stage;
  assert.equal(await stage(), 'upcoming');
  clockAt(s, 10, 45);
  assert.equal(await stage(), 'ready');
  await scanToken(s, 'in', booking);
  assert.equal(await stage(), 'inside');
  const info = (await passInfo(s, pass)).json;
  assert.equal(info.booking.bay, 'C001');
  assert.equal(info.booking.rate, 40);
  assert.deepEqual(info.rules, { earlyMinutes: 15, graceMinutes: 10, noShowMinutes: 30 });
  assert.equal(info.payments.mode, 'razorpay');
  assert.equal(info.utcOffsetMinutes, 330);
  assert.match(info.qr.in, /^\/api\/pass\/qr\?t=pass\./);
  assert.ok(!JSON.stringify(info).includes('pay_test1'), 'the pass never shows payment ids');
  clockAt(s, 13, 30);
  assert.equal(await stage(), 'overstaying');
  await scanToken(s, 'out', booking);
  assert.equal(await stage(), 'payment_due');
});

// ===== An ordinary phone camera ======================================================================
// Scanning an entry or exit QR code with a normal camera opens /scan?t=... It shows where the bay is and nothing else.

test('a normal camera scan shows the parking type, the level or zone and the lot number, and nothing else', async (t) => {
  const s = await site(t, { env: OP });
  const a = await paidBooking(s, { zone: 2 }, 'pay_spot_a');
  const b = await paidBooking(s, { vehicle: 'bike', zone: 1, plate: 'MP09CD5678' }, 'pay_spot_b');
  const cases = [
    [a, /C101/, /4-wheeler/, /Level 3/, />Level</],
    [b, /B051/, /2-wheeler/, /Zone B/, />Zone</],
  ];
  for (const [x, bay, kind, zone, label] of cases) {
    for (const k of ['in', 'out']) {
      const r = await s.get('/scan?t=' + tokenOf(s, k, x.booking), { headers: HTML_ASK }); // no sign-in
      assert.equal(r.status, 200, r.text);
      for (const re of [bay, kind, zone, label]) assert.match(r.text, re);
      assert.doesNotMatch(r.text, /\{\{/);
      assert.match(r.text, /noindex/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      // nothing that identifies the booking or the customer, and nothing about money or time
      for (const secret of [x.ref, x.booking.id, x.booking.plate, S.formatPlate(x.booking.plate), x.booking.name, x.booking.email, x.booking.phone]) {
        if (secret) assert.ok(!r.text.includes(String(secret)), `the page must not contain ${secret}`);
      }
      assert.doesNotMatch(r.text, /Booking reference|₹|rupee|pay_|order_|11:00|13:00|Scan entry and exit/i);
    }
  }
  assert.equal(a.booking.entryAt, undefined, 'opening the page records nothing');
  assert.equal(a.booking.exitScanAt, undefined);
});

test('a forged, wrong-kind or cancelled QR code shows no bay at all', async (t) => {
  const s = await site(t, { env: OP });
  const a = await paidBooking(s, { zone: 2 }, 'pay_spot_c');
  const good = tokenOf(s, 'in', a.booking);
  const forged = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  for (const bad of [forged, 'in.ZZZZZZ.' + good.split('.')[2], tokenOf(s, 'pass', a.booking), 'garbage', '']) {
    const r = await s.get('/scan?t=' + encodeURIComponent(bad), { headers: HTML_ASK, redirect: 'manual' });
    if (bad === '') {
      assert.equal(r.status, 302, 'no token at all is the admin scanner: it asks for a sign-in');
      continue;
    }
    assert.equal(r.status, 404, bad);
    assert.match(r.text, /not active/);
    assert.doesNotMatch(r.text, /C101|Level 3|4-wheeler/);
  }
  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }));
  const cancel = await s.post(`/api/dashboard/bookings/${a.ref}/cancel`, {}, as(admin));
  assert.equal(cancel.status, 200, cancel.text);
  const r = await s.get('/scan?t=' + good, { headers: HTML_ASK });
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.text, /C101|Level 3/);
});

test('a signed-in customer sees the lot details too, and the signed-in admin still gets the scanner', async (t) => {
  const s = await site(t, { env: OP });
  const a = await paidBooking(s, { zone: 2 }, 'pay_spot_d');
  const token = tokenOf(s, 'in', a.booking);
  const customer = cookieOf(await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha.verma@example.com', password: 'a-good-password' }));
  const asCustomer = await s.get('/scan?t=' + token, { headers: { cookie: customer, ...HTML_ASK } });
  assert.equal(asCustomer.status, 200);
  assert.match(asCustomer.text, /C101/);
  assert.doesNotMatch(asCustomer.text, /Staff only/);

  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }));
  const asAdmin = await s.get('/scan?t=' + token, { headers: { cookie: admin, ...HTML_ASK } });
  assert.equal(asAdmin.status, 200);
  assert.match(asAdmin.text, /Scan entry and exit/, 'the admin gets the scanner page, which records the scan');
  assert.doesNotMatch(asAdmin.text, /Where to park/);
  assert.equal(a.booking.entryAt, undefined, 'the page view alone records nothing; the scanner page posts the scan');
  const scanned = await s.post(SCAN, { token }, as(admin));
  assert.equal(scanned.status, 200, scanned.text);
});

test('the lot-details page is rate limited per visitor', async (t) => {
  const s = await site(t, { env: OP });
  const a = await paidBooking(s, {}, 'pay_spot_e');
  const token = tokenOf(s, 'in', a.booking);
  let last;
  for (let i = 0; i < 62; i++) last = await s.get('/scan?t=' + token, { headers: HTML_ASK });
  assert.equal(last.status, 429);
});

// ===== Leaving early frees the bay ====================================================================
// A booking of 11:00 to 13:00 whose vehicle is scanned out at 11:30 no longer holds its bay: the website shows it free.

const freeCarBays = async (s, time, hours = 1) => {
  const r = await s.get(`/api/availability?vehicle=car&date=2026-10-14&time=${time}&hours=${hours}`);
  assert.equal(r.status, 200, r.text);
  return r.json.free;
};

test('a vehicle that leaves before its booked end frees the bay on the website straight away', async (t) => {
  const s = await site(t);
  const { booking } = await paidBooking(s); // bay C001, 11:00 to 13:00
  assert.equal(booking.bay, 'C001');
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  clockAt(s, 11, 30);
  assert.equal(await freeCarBays(s, '11:30'), 199, 'still inside: the bay is not free');
  let dash = (await s.get('/api/dashboard')).json;
  assert.equal(dash.lot.car.inUse, 1);
  assert.equal(dash.lot.car.bays[0], 'u');

  const out = await scanToken(s, 'out', booking);
  assert.equal(out.json.outcome, 'exited');
  assert.equal(out.json.tone, 'ok');
  assert.match(out.json.message, /free again for other drivers/);
  assert.match(out.json.message, /C001/);

  // the same time window, now showing the bay as free again
  assert.equal(await freeCarBays(s, '11:30'), 200);
  assert.equal(await freeCarBays(s, '12:00'), 200);
  dash = (await s.get('/api/dashboard')).json;
  assert.equal(dash.lot.car.inUse, 0);
  assert.equal(dash.lot.car.free, 200);
  assert.equal(dash.lot.car.bays[0], 'f');

  // and another driver can book exactly that bay for the rest of the original time
  const other = await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09CD5678', time: '12:00', hours: 1 }));
  assert.equal(other.status, 201, other.text);
  assert.equal(other.json.booking.bay, 'C001');
});

test('a vehicle that is still inside keeps its bay, and one that left at or after the booked end changes nothing', async (t) => {
  const s = await site(t);
  const { booking } = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  clockAt(s, 12, 0);
  const taken = await s.post('/api/bookings', car({ bay: 'C001', plate: 'MP09CD5678', time: '12:00', hours: 1 }));
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'bay_taken');

  clockAt(s, 13, 5); // after the booked end, inside the free minutes
  const out = await scanToken(s, 'out', booking);
  assert.equal(out.json.outcome, 'exited');
  assert.doesNotMatch(out.json.message, /free again/, 'it left after the booked end, so nothing was given back early');
  assert.equal(await freeCarBays(s, '13:00'), 200, 'the bay was free after 13:00 anyway');
});

test('after leaving early the booking is over for the driver, and the same vehicle may book again', async (t) => {
  const s = await site(t);
  const { booking, pass } = await paidBooking(s);
  clockAt(s, 10, 50);
  await scanToken(s, 'in', booking);
  assert.equal((await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings.length, 1);
  clockAt(s, 11, 30);
  await scanToken(s, 'out', booking);

  assert.equal((await s.get('/api/bookings/lookup?plate=MP09AB1234')).json.bookings.length, 0, 'a booking whose vehicle left is not listed as current');
  assert.equal((await passInfo(s, pass)).json.gate.stage, 'left');
  const again = await s.post('/api/bookings', car({ time: '12:00', hours: 1 })); // same vehicle number, later the same day
  assert.equal(again.status, 201, again.text);
  const reuse = await scanToken(s, 'in', booking);
  assert.equal(reuse.json.outcome, 'already_left', 'the first booking cannot be entered again');
});
