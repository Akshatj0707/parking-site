'use strict';

// The fourth role: the gate attendant. The owner creates the login. An attendant scans customers in and out, marks an extra
// charge as collected another way and moves a booking to another bay. Nothing else: no money figures, no customer list, no
// refunds, no waiving of a charge, no logins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSite, fakeDatabase, pay, car, MINUTE } = require('./helpers');
const roles = require('../src/roles');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const JSON_ASK = { accept: 'application/json' };
const HTML_ASK = { accept: 'text/html,application/xhtml+xml' };
const ATTENDANT = { name: 'Ramesh Gate', email: 'Ramesh.Gate@Example.com', password: 'gate-pass-1234' };
const OFFICIAL = { name: 'R. K. Sharma', office: 'Municipal Corporation', email: 'rk.sharma@gov.example.in', password: 'official-pass-1' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });
const page = (cookie) => ({ headers: { cookie, ...HTML_ASK } });
const clockAt = (s, hh, mm) => {
  s.clock.t = Date.UTC(2026, 9, 14, hh, mm) - 330 * MINUTE; // lot time (UTC+5:30)
};

async function site(t, options = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...(options.env || {}) }, ...options.rest });
  t.after(() => s.close());
  return s;
}
async function adminCookie(s) {
  const r = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}
const createAttendant = (s, admin, body = ATTENDANT) => s.post('/api/dashboard/attendants', body, as(admin));
async function attendantLogin(s, body = ATTENDANT) {
  const r = await s.post('/api/auth/login', { identifier: body.email, password: body.password });
  assert.equal(r.status, 200, r.text);
  return { r, cookie: cookieOf(r) };
}
// An owner, an attendant, and one paid booking (11:00 to 13:00) with its entry and exit tokens.
async function gateSite(t, env) {
  const s = await site(t, { env });
  const admin = await adminCookie(s);
  assert.equal((await createAttendant(s, admin)).status, 201);
  const { cookie: gateCookie } = await attendantLogin(s);
  const created = await s.post('/api/bookings', car());
  assert.equal(created.status, 201, created.text);
  assert.equal((await pay(s, created, 'pay_gate1')).status, 200);
  const booking = s.store.bookings.find((b) => b.ref === created.json.booking.ref);
  const token = (kind) => s.app.locals.gate.tokenFor(kind, booking);
  return { s, admin, gateCookie, booking, token };
}
const SCAN = '/api/dashboard/gate/scan';

// ===== The role ====================================================================================

test('the attendant role holds the gate permissions and nothing else; only the owner waives a charge', () => {
  assert.deepEqual(roles.permissionsOf('attendant').sort(), ['bookings:move-bay', 'gate:scan']);
  for (const p of Object.keys(roles.PERMISSIONS).filter((x) => !['gate:scan', 'bookings:move-bay'].includes(x))) {
    assert.equal(roles.can('attendant', p), false, `an attendant must not have ${p}`);
  }
  assert.equal(roles.matrix().permissions.find((p) => p.id === 'gate:waive').roles.join(), 'admin');
  assert.equal(roles.can('official', 'gate:waive'), false);
  assert.equal(roles.can('customer', 'gate:scan'), false);
});

// ===== Creating and signing in =====================================================================

test('the owner creates an attendant login; the attendant signs in with the email and is sent to the gate scanner', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const made = await createAttendant(s, admin);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.attendant.email, 'ramesh.gate@example.com', 'the email is stored in lower case');
  assert.equal(made.json.attendant.name, 'Ramesh Gate');
  assert.ok(!JSON.stringify(made.json).includes(ATTENDANT.password), 'the password is never sent back');
  assert.deepEqual((await s.get('/api/dashboard/attendants', as(admin))).json.attendants.map((a) => a.email), ['ramesh.gate@example.com']);
  assert.deepEqual((await s.get('/api/dashboard/officials', as(admin))).json.officials, [], 'not in the list of officials');

  const { r, cookie } = await attendantLogin(s);
  assert.equal(r.json.next, '/scan');
  assert.equal(r.json.user.role, 'attendant');
  const me = await s.get('/api/me', as(cookie));
  assert.equal(me.json.user.role, 'attendant');
  assert.deepEqual(me.json.user.permissions.sort(), ['bookings:move-bay', 'gate:scan']);
});

test('an attendant is not a customer: not counted, and cannot use the customer routes', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  await createAttendant(s, admin);
  const { cookie } = await attendantLogin(s);
  assert.equal((await s.get('/api/dashboard/customers', as(admin))).json.rows.length, 0, 'the customer list has no attendants');
  const mine = await s.get('/api/account/bookings', as(cookie));
  assert.ok([401, 403].includes(mine.status), 'no "My bookings" for an attendant: ' + mine.status);
});

// ===== What an attendant can do ====================================================================

test('an attendant scans customers in and out, and the log names the attendant', async (t) => {
  const { s, gateCookie, booking, token } = await gateSite(t);
  clockAt(s, 10, 50);
  const entered = await s.post(SCAN, { token: token('in') }, as(gateCookie));
  assert.equal(entered.status, 200, entered.text);
  assert.equal(entered.json.outcome, 'entered');
  assert.equal(booking.entryBy, 'Ramesh Gate', 'who scanned the vehicle in is kept');
  assert.equal((await s.get('/api/dashboard/gate/inside', as(gateCookie))).json.count, 1);
  assert.equal((await s.get('/api/dashboard/gate/status?ref=' + booking.ref, as(gateCookie))).status, 200);
  clockAt(s, 12, 55);
  const left = await s.post(SCAN, { token: token('out') }, as(gateCookie));
  assert.equal(left.json.outcome, 'exited', left.text);
});

test('an attendant can collect an extra charge another way, but cannot waive it', async (t) => {
  const { s, admin, gateCookie, booking, token } = await gateSite(t);
  clockAt(s, 10, 50);
  assert.equal((await s.post(SCAN, { token: token('in') }, as(gateCookie))).json.outcome, 'entered');
  clockAt(s, 14, 10);
  assert.equal((await s.post(SCAN, { token: token('out') }, as(gateCookie))).json.outcome, 'payment_due');

  const waive = await s.post('/api/dashboard/gate/settle', { ref: booking.ref, method: 'waive' }, as(gateCookie));
  assert.equal(waive.status, 403, waive.text);
  assert.match(waive.json.message, /Waive the extra charge/);
  assert.equal(booking.overstay.status, 'due', 'nothing changed');

  const cash = await s.post('/api/dashboard/gate/settle', { ref: booking.ref, method: 'manual' }, as(gateCookie));
  assert.equal(cash.status, 200, cash.text);
  assert.equal(booking.overstay.settledBy, 'Ramesh Gate', 'the money that was collected is tied to a name');
  assert.ok(booking.exitAt);

  // the owner can still waive one
  const second = await s.post('/api/bookings', car({ plate: 'MP09CD5678', time: '14:30' }));
  assert.equal((await pay(s, second, 'pay_gate2')).status, 200);
  const other = s.store.bookings.find((b) => b.ref === second.json.booking.ref);
  clockAt(s, 14, 20);
  assert.equal((await s.post(SCAN, { token: s.app.locals.gate.tokenFor('in', other) }, as(admin))).json.outcome, 'entered');
  clockAt(s, 18, 30);
  assert.equal((await s.post(SCAN, { token: s.app.locals.gate.tokenFor('out', other) }, as(admin))).json.outcome, 'payment_due');
  assert.equal((await s.post('/api/dashboard/gate/settle', { ref: other.ref, method: 'waive' }, as(admin))).status, 200);
});

test('an attendant can move a booking that has not arrived to another bay', async (t) => {
  const { s, gateCookie, booking } = await gateSite(t);
  const to = s.bookings.freeBaysFor(booking, booking.startMs, s.clock.t)[0].bay;
  const r = await s.post(`/api/dashboard/bookings/${booking.ref}/move-bay`, { bay: to }, as(gateCookie));
  assert.equal(r.status, 200, r.text);
  assert.equal(booking.bay, to);
  assert.equal(booking.bayMoves[0].by, 'Ramesh Gate');
});

// ===== What an attendant cannot do =================================================================

test('an attendant sees no money, no customers and no bookings list, and cannot refund or change anything', async (t) => {
  const { s, gateCookie, booking } = await gateSite(t);
  const refused = [
    ['get', '/api/dashboard'],
    ['get', '/api/dashboard/all-bookings'],
    ['get', '/api/dashboard/bookings?plate=MP09AB1234'],
    ['get', '/api/dashboard/customers'],
    ['get', '/api/dashboard/analytics'],
    ['get', '/api/dashboard/overview'],
    ['get', '/api/dashboard/export.csv'],
    ['get', '/api/dashboard/connection'],
    ['get', '/api/dashboard/roles'],
    ['get', '/api/dashboard/officials'],
    ['get', '/api/dashboard/attendants'],
    ['post', '/api/dashboard/officials', ATTENDANT],
    ['post', '/api/dashboard/attendants', { ...ATTENDANT, email: 'other@example.com' }],
    ['post', '/api/dashboard/sample-data', {}],
    ['post', `/api/dashboard/bookings/${booking.ref}/cancel`, {}],
  ];
  for (const [method, url, body] of refused) {
    const r = method === 'get' ? await s.get(url, as(gateCookie)) : await s.post(url, body || {}, as(gateCookie));
    assert.equal(r.status, 403, `${method} ${url} should be refused to an attendant, got ${r.status}: ${r.text.slice(0, 120)}`);
  }
  assert.equal(booking.status, 'paid', 'nothing was cancelled');
});

test('the owner pages are closed to an attendant and point to the scanner; the scanner opens', async (t) => {
  const { s, gateCookie } = await gateSite(t);
  const scanner = await s.get('/scan', page(gateCookie));
  assert.equal(scanner.status, 200);
  for (const url of ['/dashboard', '/bookings', '/business', '/customers', '/analytics', '/officials']) {
    const r = await s.get(url, page(gateCookie));
    assert.equal(r.status, 403, url);
    assert.match(r.text, /Not for your role/, url);
    assert.match(r.text, /href="\/scan"/, url + ' points to the scanner');
  }
});

test('an official still opens the data pages and is refused the scanner and the owner page', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  await s.post('/api/dashboard/officials', OFFICIAL, as(admin));
  const off = cookieOf(await s.post('/api/auth/login', { identifier: OFFICIAL.email, password: OFFICIAL.password }));
  for (const url of ['/dashboard', '/bookings', '/business', '/customers', '/analytics']) assert.equal((await s.get(url, page(off))).status, 200, url);
  assert.equal((await s.get('/scan', page(off))).status, 403);
  const owner = await s.get('/officials', page(off));
  assert.equal(owner.status, 403);
  assert.match(owner.text, /Owner only/);
  assert.equal((await s.get('/api/dashboard/attendants', as(off))).status, 403, 'an official cannot see the attendants');
  assert.equal((await s.get('/officials', page(admin))).status, 200);
});

// ===== Managing the logins =========================================================================

test('creating an attendant refuses bad input, an email that is already used, and a request from another site', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const bad = async (body, code, status = 400) => {
    const r = await createAttendant(s, admin, body);
    assert.equal(r.status, status, JSON.stringify(body) + ' ' + r.text);
    assert.equal(r.json.error, code);
  };
  await bad({ ...ATTENDANT, name: '' }, 'invalid_name');
  await bad({ ...ATTENDANT, name: '<b>x</b>' }, 'invalid_name');
  await bad({ ...ATTENDANT, email: 'not-an-email' }, 'invalid_email');
  await bad({ ...ATTENDANT, password: 'short' }, 'weak_password');
  await bad({ ...ATTENDANT, password: 'password' }, 'weak_password');
  assert.equal((await createAttendant(s, admin)).status, 201);
  await bad({ ...ATTENDANT, email: 'RAMESH.GATE@example.com' }, 'email_taken', 409);
  await s.post('/api/dashboard/officials', OFFICIAL, as(admin));
  await bad({ ...ATTENDANT, email: OFFICIAL.email }, 'email_taken', 409);
  await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  await bad({ ...ATTENDANT, email: 'asha@example.com' }, 'email_taken', 409);
  const foreign = await s.post('/api/dashboard/attendants', { ...ATTENDANT, email: 'third@example.com' }, as(admin, { 'sec-fetch-site': 'cross-site' }));
  assert.equal(foreign.status, 403);
  assert.equal((await s.get('/api/dashboard/attendants', as(admin))).json.attendants.length, 1);
});

test('nobody can become an attendant by signing up, and visitors and customers cannot reach the attendant routes', async (t) => {
  const s = await site(t);
  const signup = await s.post('/api/auth/signup', { name: 'Eve', email: 'eve@example.com', password: 'a-good-password', role: 'attendant' });
  assert.equal(signup.status, 201);
  assert.equal(signup.json.user.role, 'customer');
  assert.ok([401, 403].includes((await s.get('/api/dashboard/attendants', { headers: JSON_ASK })).status));
  assert.equal((await s.get('/api/dashboard/attendants', as(cookieOf(signup)))).status, 403);
  assert.equal((await s.post('/api/dashboard/attendants', ATTENDANT, as(cookieOf(signup)))).status, 403);
  assert.equal((await s.get('/scan', page(cookieOf(signup)))).status, 403);
});

test('a new password signs the attendant out; a removed login stops at once; ids of other roles are refused', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  await createAttendant(s, admin);
  const { cookie } = await attendantLogin(s);
  const id = (await s.get('/api/dashboard/attendants', as(admin))).json.attendants[0].id;
  assert.equal((await s.get('/api/dashboard/gate/inside', as(cookie))).status, 200);

  assert.equal((await s.post(`/api/dashboard/attendants/${id}/password`, { password: 'short' }, as(admin))).status, 400);
  assert.equal((await s.post(`/api/dashboard/attendants/${id}/password`, { password: 'brand-new-pass-2' }, as(admin))).status, 200);
  assert.equal((await s.get('/api/dashboard/gate/inside', as(cookie))).status, 401, 'the old session ended');
  assert.equal((await s.post('/api/auth/login', { identifier: ATTENDANT.email, password: ATTENDANT.password })).status, 401);
  const fresh = await attendantLogin(s, { ...ATTENDANT, password: 'brand-new-pass-2' });
  assert.equal((await s.get('/api/dashboard/gate/inside', as(fresh.cookie))).status, 200);

  // an official's, a customer's or a made-up id cannot be handled through the attendant routes, and the other way round
  await s.post('/api/dashboard/officials', OFFICIAL, as(admin));
  const officialId = (await s.get('/api/dashboard/officials', as(admin))).json.officials[0].id;
  assert.equal((await s.post(`/api/dashboard/attendants/${officialId}/remove`, {}, as(admin))).status, 404);
  assert.equal((await s.post(`/api/dashboard/attendants/${officialId}/password`, { password: 'another-pass-3' }, as(admin))).status, 404);
  assert.equal((await s.post(`/api/dashboard/officials/${id}/remove`, {}, as(admin))).status, 404);
  assert.equal((await s.post('/api/dashboard/attendants/not-an-id/remove', {}, as(admin))).status, 404);

  assert.equal((await s.post(`/api/dashboard/attendants/${id}/remove`, {}, as(admin))).status, 200);
  assert.equal((await s.get('/api/dashboard/gate/inside', as(fresh.cookie))).status, 401, 'removed: signed out at once');
  assert.equal((await s.post('/api/auth/login', { identifier: ATTENDANT.email, password: 'brand-new-pass-2' })).status, 401);
  assert.deepEqual((await s.get('/api/dashboard/attendants', as(admin))).json.attendants, []);
  assert.equal((await s.get('/api/dashboard/officials', as(admin))).json.officials.length, 1, 'the official is untouched');
});

test('an attendant cannot reset a password by email: that is for customers only', async (t) => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).to[0].email);
    return { ok: true, status: 201, text: async () => '' };
  };
  const s = await makeSite({
    razorpayKeys: true,
    env: { ...OP, EMAIL_API_KEY: 'k-123456', EMAIL_FROM: 'owner@example.com', PUBLIC_URL: 'http://127.0.0.1:1' },
    mail: { fetchImpl },
  });
  t.after(() => s.close());
  const admin = await adminCookie(s);
  await createAttendant(s, admin);
  const r = await s.post('/api/auth/forgot', { email: ATTENDANT.email });
  assert.equal(r.status, 200, r.text);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(sent, [], 'no email was sent');
  assert.equal((await s.post('/api/auth/login', { identifier: ATTENDANT.email, password: ATTENDANT.password })).status, 200, 'the password is unchanged');
});

// ===== Keeping it ==================================================================================

test('an attendant login survives a restart, and a hand-made cookie does not make anyone an attendant', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-attendant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await makeSite({ razorpayKeys: true, env: OP, existingDir: dir });
  const admin = await adminCookie(first);
  await createAttendant(first, admin);
  const { cookie } = await attendantLogin(first);
  await first.close();

  const second = await makeSite({ razorpayKeys: true, env: OP, existingDir: dir });
  t.after(() => second.close());
  assert.equal((await second.get('/api/dashboard/gate/inside', as(cookie))).status, 200, 'the same sign-in still works');
  assert.equal((await second.post('/api/auth/login', { identifier: ATTENDANT.email, password: ATTENDANT.password })).status, 200);

  const signup = await second.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  const [payload, sig] = cookieOf(signup).replace('bf_session=', '').split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  data.r = 'attendant';
  const forged = 'bf_session=' + Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + sig;
  assert.equal((await second.get('/api/dashboard/gate/inside', as(forged))).status, 401);
});

test('with a database, attendant logins are kept there next to the customers', async (t) => {
  const database = fakeDatabase();
  const a = await makeSite({ razorpayKeys: true, database, env: OP });
  const admin = await adminCookie(a);
  assert.equal((await createAttendant(a, admin)).status, 201);
  await a.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  await a.close();
  assert.deepEqual(database.docs_of('test:user').map((u) => u.role).sort(), ['attendant', 'customer']);

  const b = await makeSite({ razorpayKeys: true, database, env: OP });
  t.after(() => b.close());
  assert.equal((await b.post('/api/auth/login', { identifier: ATTENDANT.email, password: ATTENDANT.password })).status, 200);
});

test('the owner page and the scanner script show server text as text and hide what an attendant may not use', () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'officials.html'), 'utf8');
  for (const id of ['add-form-a', 'a-name', 'a-email', 'a-password', 'add-go-a', 'add-message-a', 'list-a', 'totals-a']) assert.ok(html.includes(`id="${id}"`), id);
  const js = fs.readFileSync(path.join(root, 'js', 'officials.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(js));
  const scan = fs.readFileSync(path.join(root, 'js', 'scan.js'), 'utf8');
  assert.match(scan, /gate:waive/, 'the scanner hides "Waive the charge" from staff who may not use it');
});
