'use strict';

// Two things that protect the next customer's bay:
//   1. A booking nobody turns up for lets go of its bay after NO_SHOW_RELEASE_MINUTES (the money is kept). The vehicle may still
//      come in later if nobody else has been given the bay.
//   2. When a vehicle is parked past its booked time on a bay that someone else has booked, the admin is warned and can send the
//      waiting booking to another free bay.
// The clock starts at 10:00 on Wed 14 Oct 2026 (lot time). The default booking is 11:00 to 13:00 for a car.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeSite, pay, car, MINUTE } = require('./helpers');
const { loadConfig } = require('../src/config');
const { can } = require('../src/roles');
const { releaseAtOf, isReleased } = require('../src/gate');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const JSON_ASK = { accept: 'application/json' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

async function site(t, env = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...env } });
  t.after(() => s.close());
  s.admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }));
  return s;
}

const gateOf = (s) => s.app.locals.gate;
const clockAt = (s, hh, mm) => {
  s.clock.t = Date.UTC(2026, 9, 14, hh, mm) - 330 * MINUTE; // lot time (UTC+5:30)
};

let payments = 0;
async function book(s, over = {}) {
  const created = await s.post('/api/bookings', car(over));
  assert.equal(created.status, 201, created.text);
  payments += 1;
  const paid = await pay(s, created, 'pay_bw' + payments);
  assert.equal(paid.status, 200, paid.text);
  const view = paid.json.booking;
  return { ref: view.ref, pass: new URL('http://x' + view.pass).searchParams.get('t'), booking: s.store.bookings.find((b) => b.ref === view.ref) };
}

const scan = (s, kind, b) => s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor(kind, b.booking) }, as(s.admin));
const warnings = (s) => s.bookings.bayWarnings(s.clock.t);
const move = (s, ref, bay, cookie = s.admin) => s.post(`/api/dashboard/bookings/${ref}/move-bay`, { bay }, as(cookie));
const plateOf = (n) => `MP09AB${String(5000 + n)}`;

// ===== Settings and rules ==========================================================================

test('the no-show time and the warning time come from the settings and stay within sensible limits', () => {
  const read = (env) => loadConfig({ CUSTOMER_LOGIN_REQUIRED: 'off', ...env }).gate;
  assert.equal(read({}).noShowMinutes, 30);
  assert.equal(read({}).bayWarningMinutes, 30);
  assert.equal(read({ NO_SHOW_RELEASE_MINUTES: '45' }).noShowMinutes, 45);
  assert.equal(read({ NO_SHOW_RELEASE_MINUTES: '0' }).noShowMinutes, 0, '0 turns it off');
  assert.equal(read({ NO_SHOW_RELEASE_MINUTES: '9999' }).noShowMinutes, 240);
  assert.equal(read({ NO_SHOW_RELEASE_MINUTES: 'soon' }).noShowMinutes, 30, 'nonsense falls back to the default');
  assert.equal(read({ BAY_WARNING_MINUTES: '1' }).bayWarningMinutes, 5);
  assert.equal(read({ BAY_WARNING_MINUTES: '999' }).bayWarningMinutes, 240);
});

test('only the admin may move a booking to another bay', () => {
  assert.equal(can('admin', 'bookings:move-bay'), true);
  assert.equal(can('official', 'bookings:move-bay'), false);
  assert.equal(can('customer', 'bookings:move-bay'), false);
});

test('a booking is released only when the no-show time is on and falls inside the booked time', () => {
  const cfg = { noShowMinutes: 30 };
  const b = { status: 'paid', startMs: 1000 * MINUTE, endMs: 1120 * MINUTE };
  assert.equal(releaseAtOf(b, cfg), 1030 * MINUTE);
  assert.equal(releaseAtOf(b, { noShowMinutes: 0 }), null, 'off');
  assert.equal(releaseAtOf({ ...b, endMs: 1030 * MINUTE }, cfg), null, 'the booked time is over by then: nothing left to give away');
  assert.equal(isReleased(b, 1029 * MINUTE, cfg), false);
  assert.equal(isReleased(b, 1030 * MINUTE, cfg), true);
  assert.equal(isReleased(b, 1120 * MINUTE, cfg), false, 'after the booked end there is nothing left');
  assert.equal(isReleased({ ...b, entryAt: 1010 * MINUTE }, 1060 * MINUTE, cfg), false, 'a vehicle that came in holds its bay');
  assert.equal(isReleased({ ...b, status: 'refunded' }, 1060 * MINUTE, cfg), false);
});

// ===== No-show: the bay is released ================================================================

test('a bay nobody arrives for is free for others after 30 minutes, and not a minute before', async (t) => {
  const s = await site(t);
  const a = await book(s, { plate: plateOf(1) }); // 11:00 to 13:00
  const bay = a.booking.bay;

  clockAt(s, 11, 29);
  const early = await s.post('/api/bookings', car({ plate: plateOf(2), time: '11:30', hours: 1 }));
  assert.equal(early.status, 201, early.text);
  assert.notEqual(early.json.booking.bay, bay, 'still held at 11:29');

  clockAt(s, 11, 31);
  const later = await s.post('/api/bookings', car({ plate: plateOf(3), time: '11:30', hours: 1 }));
  assert.equal(later.status, 201, later.text);
  assert.equal(later.json.booking.bay, bay, 'released: the first free bay is that one again');
  assert.equal(a.booking.status, 'paid', 'the no-show booking itself stays paid: nothing is refunded');
  assert.equal(s.fake.calls.refunds.length, 0);
});

test('the pass says the bay was released, and the dashboard counts the released bays', async (t) => {
  const s = await site(t);
  const a = await book(s);
  clockAt(s, 11, 20);
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(a.pass))).json.gate.released, false);
  assert.equal(s.bookings.dashboard().gate.released, 0);
  clockAt(s, 11, 30);
  const info = (await s.get('/api/pass?t=' + encodeURIComponent(a.pass))).json;
  assert.equal(info.gate.released, true);
  assert.equal(info.gate.stage, 'ready');
  assert.equal(info.rules.noShowMinutes, 30);
  assert.equal(s.bookings.dashboard().gate.released, 1);
  clockAt(s, 13, 0);
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(a.pass))).json.gate.released, false, 'over: the plain "time is over" message takes its place');
});

test('with NO_SHOW_RELEASE_MINUTES=0 a bay is held for the whole booked time', async (t) => {
  const s = await site(t, { NO_SHOW_RELEASE_MINUTES: '0' });
  const a = await book(s);
  clockAt(s, 12, 0);
  assert.equal(s.bookings.takenBays('car', s.clock.t, s.clock.t + 30 * MINUTE, s.clock.t).has(a.booking.bay), true);
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(a.pass))).json.gate.released, false);
});

test('a late vehicle still gets in when its bay is still free, and then holds the bay again', async (t) => {
  const s = await site(t);
  const a = await book(s);
  clockAt(s, 11, 45);
  assert.equal(s.bookings.takenBays('car', s.clock.t, a.booking.endMs, s.clock.t).has(a.booking.bay), false, 'released while it waits');
  const r = await scan(s, 'in', a);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.outcome, 'entered');
  assert.match(r.json.message, /45 minutes after the start/);
  assert.equal(r.json.gate.released, false, 'inside now');
  assert.equal(s.bookings.takenBays('car', 12 * 60 * MINUTE, a.booking.endMs, s.clock.t).has(a.booking.bay), true, 'its whole booked time holds the bay again');
});

test('a late vehicle is turned away when someone else was given its bay, and the admin can move it and let it in', async (t) => {
  const s = await site(t);
  const a = await book(s, { plate: plateOf(1) }); // 11:00 to 13:00
  clockAt(s, 11, 31);
  const other = await s.post('/api/bookings', car({ plate: plateOf(2), time: '11:30', hours: 1, bay: a.booking.bay }));
  assert.equal(other.status, 201, other.text);
  await pay(s, other, 'pay_other');

  clockAt(s, 11, 45);
  const r = await scan(s, 'in', a);
  assert.equal(r.json.outcome, 'released');
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /now booked by someone else/);
  assert.equal(a.booking.entryAt, undefined, 'not scanned in');

  const free = s.bookings.freeBaysFor(a.booking, s.clock.t, s.clock.t);
  assert.ok(free.length > 0);
  const moved = await move(s, a.ref, free[0].bay);
  assert.equal(moved.status, 200, moved.text);
  assert.equal(a.booking.bay, free[0].bay);
  const again = await scan(s, 'in', a); // the same entry QR code: it does not name the bay
  assert.equal(again.json.outcome, 'entered', again.text);
  assert.match(again.json.message, new RegExp(`bay ${free[0].bay}`));
});

// ===== A vehicle past its time blocks the next booking =============================================

// A is parked 11:00 to 13:00 on its bay; N has booked the same bay for `time` (one hour).
async function blocked(s, time = '13:00') {
  const a = await book(s, { plate: plateOf(1) });
  const n = await book(s, { plate: plateOf(2), time, hours: 1, bay: a.booking.bay });
  clockAt(s, 10, 50);
  assert.equal((await scan(s, 'in', a)).json.outcome, 'entered');
  return { a, n };
}

test('no warning while the vehicle is inside its booked time, a "soon" warning after it, and "waiting" once the next booking has started', async (t) => {
  const s = await site(t);
  const { a, n } = await blocked(s, '14:00'); // the vehicle should leave by 13:00
  clockAt(s, 12, 55);
  assert.deepEqual(warnings(s), [], 'still inside its booked time');
  clockAt(s, 13, 5);
  assert.deepEqual(warnings(s), [], 'past its time, but the next booking is 55 minutes away: not yet');
  clockAt(s, 13, 35);
  let w = warnings(s);
  assert.equal(w.length, 1, 'the next booking starts in 25 minutes: inside the 30 minutes that matter');
  assert.equal(w[0].level, 'soon');
  assert.equal(w[0].bay, a.booking.bay);
  assert.equal(w[0].parked.ref, a.ref);
  assert.equal(w[0].parked.overMinutes, 35);
  assert.equal(w[0].next.ref, n.ref);
  assert.equal(w[0].next.minutesToStart, 25);
  clockAt(s, 14, 1);
  w = warnings(s);
  assert.equal(w[0].level, 'waiting');
  assert.ok(w[0].next.minutesToStart <= 0);
});

test('a booking that starts far later is no worry yet', async (t) => {
  const s = await site(t);
  await blocked(s, '15:00');
  clockAt(s, 13, 20);
  assert.deepEqual(warnings(s), []);
  clockAt(s, 14, 35);
  assert.equal(warnings(s).length, 1, 'now 25 minutes away');
});

test('the suggested free bays are in the same zone first and never a bay with a vehicle still in it', async (t) => {
  const s = await site(t);
  // a second vehicle, also past its time, sits in the first bay of the zone
  const neighbour = await book(s, { plate: plateOf(3), time: '10:30', hours: 1 });
  const { a, n } = await blocked(s, '13:00');
  assert.equal((await scan(s, 'in', neighbour)).json.outcome, 'entered');
  clockAt(s, 13, 5);
  const w = warnings(s).find((x) => x.next.ref === n.ref);
  assert.ok(w, 'the blocked bay is reported');
  assert.equal(w.level, 'waiting');
  assert.ok(w.free.length >= 1);
  assert.ok(!w.free.some((f) => f.bay === a.booking.bay), 'not the blocked bay itself');
  assert.ok(!w.free.some((f) => f.bay === neighbour.booking.bay), 'not a bay where a vehicle is still parked');
  assert.ok(w.free.every((f) => f.zone === 'Level 1'), 'same zone first');
});

test('the warning shows on the dashboard and on the scanner page list, and goes away when the vehicle leaves', async (t) => {
  const s = await site(t);
  const { a, n } = await blocked(s);
  clockAt(s, 13, 5);
  const dash = await s.get('/api/dashboard', as(s.admin));
  assert.equal(dash.status, 200, dash.text);
  assert.equal(dash.json.bayWarnings.length, 1);
  assert.equal(dash.json.bayWarnings[0].next.ref, n.ref);
  const inside = await s.get('/api/dashboard/gate/inside', as(s.admin));
  assert.equal(inside.json.warnings.length, 1);

  const out = await scan(s, 'out', a); // 5 minutes late: inside the free grace period
  assert.equal(out.status, 200, out.text);
  assert.ok(a.booking.exitAt, 'it left');
  assert.deepEqual(warnings(s), []);
});

test('with no warning the lists are empty arrays, not missing', async (t) => {
  const s = await site(t);
  const dash = await s.get('/api/dashboard', as(s.admin));
  assert.deepEqual(dash.json.bayWarnings, []);
  assert.deepEqual((await s.get('/api/dashboard/gate/inside', as(s.admin))).json.warnings, []);
});

// ===== Moving a booking to another bay =============================================================

test('moving the waiting booking clears the warning, keeps the QR codes working and tells the customer on the pass', async (t) => {
  const s = await site(t);
  const { n } = await blocked(s);
  clockAt(s, 13, 5);
  const w = warnings(s)[0];
  const to = w.free[0].bay;
  const r = await move(s, n.ref, to);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.booking.bay, to);
  assert.match(r.json.message, new RegExp(to));
  assert.deepEqual(warnings(s), []);
  assert.equal(n.booking.bayMoves.length, 1);
  assert.equal(n.booking.bayMoves[0].to, to);
  assert.equal(n.booking.bayMoves[0].by, 'operator', 'who moved it is kept');
  const info = (await s.get('/api/pass?t=' + encodeURIComponent(n.pass))).json;
  assert.equal(info.booking.bay, to);
  assert.equal(info.bayMoved.to, to);
  const entered = await scan(s, 'in', n);
  assert.equal(entered.json.outcome, 'entered', entered.text);
  assert.match(entered.json.message, new RegExp(`bay ${to}`));
});

test('a booking cannot be moved onto a bay that is booked, occupied, of the wrong kind, or the same one', async (t) => {
  const s = await site(t);
  const gone = await book(s, { plate: plateOf(5), time: '10:30', hours: 1, bay: 'C010' });
  const { a, n } = await blocked(s);
  const taken = await book(s, { plate: plateOf(4), time: '13:00', hours: 1 }); // another booking for the same hour
  assert.equal((await scan(s, 'in', gone)).json.outcome, 'entered');
  clockAt(s, 13, 5);
  const code = async (bay) => {
    const r = await move(s, n.ref, bay);
    return [r.status, r.json && r.json.error];
  };
  assert.deepEqual(await code(taken.booking.bay), [409, 'bay_taken']);
  assert.deepEqual(await code(a.booking.bay), [409, 'same_bay']);
  assert.deepEqual(await code('B001'), [400, 'invalid_bay'], 'a two-wheeler bay for a car');
  assert.deepEqual(await code('C999'), [400, 'invalid_bay']);
  assert.deepEqual(await code(''), [400, 'invalid_bay']);
  assert.equal(n.booking.bay, a.booking.bay, 'nothing changed');

  // a vehicle that is physically still in a bay whose own booking has ended
  assert.deepEqual(await code('C010'), [409, 'bay_occupied']);
});

test('only a paid booking that has not arrived can be moved', async (t) => {
  const s = await site(t);
  const old = await book(s, { plate: plateOf(8), time: '11:00', hours: 1, bay: 'C030' });
  const { a } = await blocked(s);
  clockAt(s, 10, 55);
  const inside = await move(s, a.ref, 'C040');
  assert.equal(inside.status, 409);
  assert.equal(inside.json.error, 'already_parked');
  const unknown = await move(s, 'ZZZZZZ', 'C040');
  assert.equal(unknown.json.error, 'unknown_booking');
  const bad = await move(s, 'x', 'C040');
  assert.equal(bad.json.error, 'invalid_ref');

  const created = await s.post('/api/bookings', car({ plate: plateOf(6), time: '16:00' })); // never paid
  assert.equal((await move(s, created.json.booking.ref, 'C040')).json.error, 'not_movable');
  clockAt(s, 12, 30); // the booking of 11:00 to 12:00 is over, and nobody came
  const ended = await move(s, old.ref, 'C040');
  assert.equal(ended.status, 409);
  assert.equal(ended.json.error, 'not_movable');
});

test('moving needs the admin sign-in, a customer cannot, and a page of another website cannot', async (t) => {
  const s = await site(t);
  const { n } = await blocked(s);
  clockAt(s, 13, 5);
  const to = warnings(s)[0].free[0].bay;
  const nobody = await s.post(`/api/dashboard/bookings/${n.ref}/move-bay`, { bay: to }, { headers: JSON_ASK });
  assert.ok([401, 403].includes(nobody.status), 'no sign-in: ' + nobody.status);
  const signup = await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  const customer = await move(s, n.ref, to, cookieOf(signup));
  assert.ok([401, 403].includes(customer.status), 'a customer: ' + customer.status);
  const foreign = await s.post(`/api/dashboard/bookings/${n.ref}/move-bay`, { bay: to }, as(s.admin, { 'sec-fetch-site': 'cross-site' }));
  assert.equal(foreign.status, 403);
  assert.equal(n.booking.bay, warnings(s)[0].bay, 'still on the blocked bay');
});

// ===== What the pages promise ======================================================================

test('the terms, the refund page and the home page tell the truth about a customer who does not arrive', async (t) => {
  const s = await site(t);
  for (const url of ['/terms', '/refunds', '/']) {
    const page = await s.get(url);
    assert.equal(page.status, 200, url);
    assert.match(page.text, /30 minutes after the start, the bay is released for other customers and the amount is not refunded/, url);
    assert.ok(!page.text.includes('{{'), url + ' has an unfilled placeholder');
  }
  const off = await site(t, { NO_SHOW_RELEASE_MINUTES: '0' });
  const terms = await off.get('/terms');
  assert.match(terms.text, /kept for the whole time you booked, even if you arrive late/);
  assert.ok(!terms.text.includes('is released for other customers'));
});
