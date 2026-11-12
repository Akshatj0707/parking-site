'use strict';

// The third role: the government official. The owner creates the login; the official sees ALL the data and changes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSite, fakeDatabase, pay, car, bike } = require('./helpers');
const roles = require('../src/roles');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const JSON_ASK = { accept: 'application/json' };
const HTML_ASK = { accept: 'text/html,application/xhtml+xml' };
const OFFICIAL = { name: 'R. K. Sharma', office: 'Municipal Corporation', email: 'RK.Sharma@Gov.example.in', password: 'official-pass-1' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

async function site(t, options = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...(options.env || {}) }, ...options.rest });
  t.after(() => s.close());
  return s;
}
async function signUp(s, name, email) {
  const r = await s.post('/api/auth/signup', { name, email, password: 'a-good-password' });
  assert.equal(r.status, 201, r.text);
  return cookieOf(r);
}
async function adminCookie(s) {
  const r = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}
async function createOfficial(s, admin, body = OFFICIAL) {
  return s.post('/api/dashboard/officials', body, as(admin));
}
async function officialCookie(s, body = OFFICIAL) {
  const r = await s.post('/api/auth/login', { identifier: body.email, password: body.password });
  assert.equal(r.status, 200, r.text);
  return { r, cookie: cookieOf(r) };
}
async function bookPaid(s, cookie, body, paymentId) {
  const created = await s.post('/api/bookings', body, cookie ? { headers: { cookie } } : undefined);
  assert.equal(created.status, 201, created.text);
  assert.equal((await pay(s, created, paymentId)).status, 200);
  return created.json.booking;
}

test('the official role: sees all the data, changes nothing, and is the only role besides the owner that can read it', () => {
  assert.deepEqual(roles.permissionsOf('official').sort(), ['analytics:view', 'bookings:export', 'bookings:view-all', 'customers:view', 'payments:view']);
  for (const p of ['bookings:cancel-refund', 'system:view', 'accounts:manage', 'samples:manage', 'booking:create']) {
    assert.equal(roles.can('official', p), false, `an official must not have ${p}`);
  }
  for (const p of ['accounts:manage', 'samples:manage']) assert.equal(roles.can('customer', p), false);
});

test('the owner creates an official login, and the official signs in with the email and password', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const made = await createOfficial(s, admin);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.official.email, 'rk.sharma@gov.example.in');
  assert.equal(made.json.official.office, 'Municipal Corporation');
  assert.ok(!/pass|password/i.test(JSON.stringify(made.json)), 'no password or hash is ever sent back');

  const { r, cookie } = await officialCookie(s);
  assert.equal(r.json.next, '/dashboard');
  assert.deepEqual(r.json.user, { role: 'official', name: 'R. K. Sharma', email: 'rk.sharma@gov.example.in', permissions: roles.permissionsOf('official') });
  assert.equal((await s.get('/api/me', as(cookie))).json.user.role, 'official');

  const listed = (await s.get('/api/dashboard/officials', as(admin))).json.officials;
  assert.deepEqual(listed.map((o) => o.email), ['rk.sharma@gov.example.in']);
  const file = fs.readFileSync(path.join(s.dir, 'users.json'), 'utf8');
  assert.ok(!file.includes(OFFICIAL.password), 'the password is kept only as a hash');
});

test('an official sees all the data, including every customer\'s bookings, the numbers and the spreadsheet', async (t) => {
  const s = await site(t);
  const asha = await signUp(s, 'Asha Verma', 'asha@example.com');
  const ravi = await signUp(s, 'Ravi Kumar', 'ravi@example.com');
  await bookPaid(s, asha, car(), 'pay_a');
  await bookPaid(s, ravi, bike({ plate: 'MP09CD5678' }), 'pay_b');
  const admin = await adminCookie(s);
  assert.equal((await createOfficial(s, admin)).status, 201);
  const { cookie } = await officialCookie(s);

  const all = await s.get('/api/dashboard/all-bookings', as(cookie));
  assert.equal(all.status, 200);
  assert.equal(all.json.totals.count, 2, 'both customers\' bookings');
  for (const url of ['/api/dashboard', '/api/dashboard/overview', '/api/dashboard/customers', '/api/dashboard/analytics', '/api/dashboard/roles', '/api/dashboard/bookings?plate=MP09AB1234']) {
    assert.equal((await s.get(url, as(cookie))).status, 200, url);
  }
  const csv = await s.get('/api/dashboard/export.csv', as(cookie));
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Asha Verma/);
  assert.match(csv.text, /Ravi Kumar/);

  // the official's own login is not a customer: not in the customer list, not in the customer count
  const customers = (await s.get('/api/dashboard/customers', as(cookie))).json;
  assert.deepEqual(customers.rows.map((r) => r.email).sort(), ['asha@example.com', 'ravi@example.com']);
  assert.equal((await s.get('/api/dashboard/overview', as(cookie))).json.customers.registered, 2);

  // the pages open too, labelled for them, and without the owner's Officials link
  for (const page of ['/dashboard', '/business', '/bookings', '/customers', '/analytics']) {
    assert.equal((await s.get(page, { headers: { cookie, ...HTML_ASK } })).status, 200, page);
  }
});

test('an official cannot refund, run the setup check, add sample data or manage logins', async (t) => {
  const s = await site(t);
  const asha = await signUp(s, 'Asha Verma', 'asha@example.com');
  const booking = await bookPaid(s, asha, car(), 'pay_a');
  const admin = await adminCookie(s);
  await createOfficial(s, admin);
  const { cookie } = await officialCookie(s);

  assert.equal((await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(cookie))).status, 403);
  assert.equal(s.store.bookings.find((b) => b.ref === booking.ref).status, 'paid', 'the booking is untouched');
  assert.equal((await s.get('/api/dashboard/connection', as(cookie))).status, 403);
  assert.equal((await s.post('/api/dashboard/sample-data', { action: 'add' }, as(cookie))).status, 403);
  assert.equal((await s.get('/api/dashboard/officials', as(cookie))).status, 403);
  assert.equal((await s.post('/api/dashboard/officials', { ...OFFICIAL, email: 'other@gov.example.in' }, as(cookie))).status, 403);
  const row = (await s.get('/api/dashboard/officials', as(admin))).json.officials[0];
  assert.equal((await s.post(`/api/dashboard/officials/${row.id}/password`, { password: 'another-pass-9' }, as(cookie))).status, 403);
  assert.equal((await s.post(`/api/dashboard/officials/${row.id}/remove`, {}, as(cookie))).status, 403);
  assert.equal((await s.get('/api/dashboard/officials', as(admin))).json.officials.length, 1, 'still there');

  const page = await s.get('/officials', { headers: { cookie, ...HTML_ASK } });
  assert.equal(page.status, 403);
  assert.match(page.text, /Owner only/);
  assert.equal((await s.get('/officials', { headers: { cookie: admin, ...HTML_ASK } })).status, 200, 'the owner opens it');
  // an official has no bookings of their own and cannot book
  assert.equal((await s.get('/api/account/bookings', as(cookie))).status, 403);
  assert.equal((await s.post('/api/bookings', car({ plate: 'MP09ZZ9999' }), as(cookie))).status, 403);
});

test('nobody can become an official by signing up, and customers and visitors cannot reach the officials routes', async (t) => {
  const s = await site(t);
  const sneaky = await s.post('/api/auth/signup', { name: 'Sneaky', email: 'sneaky@example.com', password: 'a-good-password', role: 'official' });
  assert.equal(sneaky.status, 201);
  assert.equal(sneaky.json.user.role, 'customer');
  const cookie = cookieOf(sneaky);
  assert.equal((await s.get('/api/dashboard', as(cookie))).status, 403);
  assert.equal((await s.get('/api/dashboard/officials', as(cookie))).status, 403);
  assert.equal((await s.post('/api/dashboard/officials', OFFICIAL, as(cookie))).status, 403);
  assert.equal((await s.get('/api/dashboard/officials', { headers: JSON_ASK })).status, 401);
  assert.equal((await s.post('/api/dashboard/officials', OFFICIAL, { headers: JSON_ASK })).status, 401);
  assert.equal((await s.get('/officials', { headers: { cookie, ...HTML_ASK } })).status, 403);
  const admin = await adminCookie(s);
  assert.equal((await s.get('/api/dashboard/officials', as(admin))).json.officials.length, 0);
});

test('creating a login refuses bad input and an email that is already used, and a request from another site', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  await signUp(s, 'Asha Verma', 'asha@example.com');
  const bad = async (body, code, status = 400) => {
    const r = await createOfficial(s, admin, { ...OFFICIAL, ...body });
    assert.equal(r.status, status, JSON.stringify(body) + r.text);
    assert.equal(r.json.error, code);
  };
  await bad({ email: 'nope' }, 'invalid_email');
  await bad({ name: '  ' }, 'invalid_name');
  await bad({ password: 'short' }, 'weak_password');
  await bad({ password: 'password123' }, 'weak_password');
  await bad({ office: '<b>x</b>' }, 'invalid_office');
  await bad({ email: 'asha@example.com' }, 'email_taken', 409); // already a customer
  assert.equal((await createOfficial(s, admin)).status, 201);
  await bad({}, 'email_taken', 409); // already an official
  await bad({ email: 'OPERATOR' }, 'invalid_email');

  // a button pressed on another website is refused even with the owner's cookie
  const foreign = await s.post('/api/dashboard/officials', { ...OFFICIAL, email: 'x@gov.example.in' }, { headers: { cookie: admin, ...JSON_ASK, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  assert.equal(foreign.status, 403);
  assert.equal((await s.get('/api/dashboard/officials', as(admin))).json.officials.length, 1);
});

test('a new password signs the official out and the old one stops working; a removed login stops at once', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  await createOfficial(s, admin);
  const { cookie } = await officialCookie(s);
  const id = (await s.get('/api/dashboard/officials', as(admin))).json.officials[0].id;

  assert.equal((await s.post(`/api/dashboard/officials/${id}/password`, { password: 'short' }, as(admin))).status, 400);
  assert.equal((await s.post(`/api/dashboard/officials/${id}/password`, { password: 'brand-new-pass-2' }, as(admin))).status, 200);
  assert.equal((await s.get('/api/dashboard/all-bookings', as(cookie))).status, 401, 'the old session ended');
  const old = await s.post('/api/auth/login', { identifier: OFFICIAL.email, password: OFFICIAL.password });
  assert.equal(old.status, 401);
  const fresh = await officialCookie(s, { ...OFFICIAL, password: 'brand-new-pass-2' });
  assert.equal((await s.get('/api/dashboard/all-bookings', as(fresh.cookie))).status, 200);

  // ids that are not an official's are refused: a customer's id cannot be removed or given a password here
  const customerCookie = await signUp(s, 'Asha Verma', 'asha@example.com');
  const customerId = (await s.get('/api/dashboard/customers', as(admin))).json.rows[0].id;
  assert.ok(customerId);
  assert.equal((await s.post(`/api/dashboard/officials/${customerId}/remove`, {}, as(admin))).status, 404);
  assert.equal((await s.post('/api/dashboard/officials/not-an-id/remove', {}, as(admin))).status, 404);
  assert.equal((await s.get('/api/me', as(customerCookie))).json.user.role, 'customer', 'the customer is untouched');

  assert.equal((await s.post(`/api/dashboard/officials/${id}/remove`, {}, as(admin))).status, 200);
  assert.equal((await s.get('/api/dashboard/all-bookings', as(fresh.cookie))).status, 401, 'removed: signed out at once');
  assert.equal((await s.post('/api/auth/login', { identifier: OFFICIAL.email, password: 'brand-new-pass-2' })).status, 401);
  assert.deepEqual((await s.get('/api/dashboard/officials', as(admin))).json.officials, []);
});

test('an official login survives a restart, and a forged or changed cookie does not make anyone an official', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-official-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await makeSite({ razorpayKeys: true, env: OP, existingDir: dir });
  const admin = await adminCookie(first);
  await createOfficial(first, admin);
  const { cookie } = await officialCookie(first);
  await first.close();

  const second = await makeSite({ razorpayKeys: true, env: OP, existingDir: dir });
  t.after(() => second.close());
  assert.equal((await second.get('/api/dashboard/all-bookings', as(cookie))).status, 200, 'the same sign-in still works');
  assert.equal((await second.post('/api/auth/login', { identifier: OFFICIAL.email, password: OFFICIAL.password })).status, 200);

  // a customer's cookie with the role swapped by hand fails the signature check
  const customer = await signUp(second, 'Asha Verma', 'asha@example.com');
  const [payload, sig] = customer.replace('bf_session=', '').split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  data.r = 'official';
  const forged = 'bf_session=' + Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + sig;
  assert.equal((await second.get('/api/dashboard/all-bookings', as(forged))).status, 401);
});

test('with a database, official logins are kept there next to the customers', async (t) => {
  const database = fakeDatabase();
  const a = await makeSite({ razorpayKeys: true, database, env: OP });
  const admin = await adminCookie(a);
  assert.equal((await createOfficial(a, admin)).status, 201);
  await signUp(a, 'Asha Verma', 'asha@example.com');
  await a.close();
  const stored = database.docs_of('test:user');
  assert.deepEqual(stored.map((u) => u.role).sort(), ['customer', 'official']);

  const b = await makeSite({ razorpayKeys: true, database, env: OP });
  t.after(() => b.close());
  assert.equal((await b.post('/api/auth/login', { identifier: OFFICIAL.email, password: OFFICIAL.password })).status, 200);
  const admin2 = await adminCookie(b);
  const id = (await b.get('/api/dashboard/officials', as(admin2))).json.officials[0].id;
  assert.equal((await b.post(`/api/dashboard/officials/${id}/remove`, {}, as(admin2))).status, 200);
  await b.storage.users.settledWithin(2000);
  assert.deepEqual(database.docs_of('test:user').map((u) => u.role), ['customer'], 'the removal reached the database');
});

test('the login page tells officials where to sign in, and the owner page script shows server text as text', () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'officials.html'), 'utf8');
  assert.ok(html.includes('/js/officials.js') && !/<script>(?!\s*<\/script>)/.test(html), 'a script file, no inline script');
  const js = fs.readFileSync(path.join(root, 'js', 'officials.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(js), 'nothing from the server is put on the page as HTML');
  assert.match(fs.readFileSync(path.join(root, 'js', 'auth.js'), 'utf8'), /government officials sign in with their email/);
});
