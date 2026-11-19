'use strict';

// The second admin: an email and password that live only in the server settings (EXTRA_ADMIN_EMAIL, EXTRA_ADMIN_PASSWORD).
// It has the same rights as the operator: every booking, every customer, cancel and refund, the setup check, official logins.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSite, pay, car } = require('./helpers');
const roles = require('../src/roles');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const EXTRA = { EXTRA_ADMIN_EMAIL: 'Second.Admin@Example.com', EXTRA_ADMIN_PASSWORD: 'second-admin-pass-1', EXTRA_ADMIN_NAME: 'Second Admin' };
const JSON_ASK = { accept: 'application/json' };
const HTML_ASK = { accept: 'text/html,application/xhtml+xml' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

async function site(t, env = EXTRA, rest = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...env }, ...rest });
  t.after(() => s.close());
  return s;
}
async function signUp(s, name, email) {
  const r = await s.post('/api/auth/signup', { name, email, password: 'a-good-password' });
  assert.equal(r.status, 201, r.text);
  return cookieOf(r);
}
async function adminLogin(s, password = EXTRA.EXTRA_ADMIN_PASSWORD, identifier = 'second.admin@example.com') {
  return s.post('/api/auth/login', { identifier, password });
}
async function bookPaid(s, cookie, paymentId) {
  const created = await s.post('/api/bookings', car(), { headers: { cookie } });
  assert.equal(created.status, 201, created.text);
  assert.equal((await pay(s, created, paymentId)).status, 200);
  return created.json.booking;
}

test('the second admin signs in with the email and has the full admin rights', async (t) => {
  const s = await site(t);
  const login = await adminLogin(s);
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.user.role, 'admin');
  assert.equal(login.json.user.email, 'second.admin@example.com');
  assert.equal(login.json.next, '/dashboard');
  assert.deepEqual(login.json.user.permissions.slice().sort(), roles.permissionsOf('admin').slice().sort());
  const cookie = cookieOf(login);

  const me = await s.get('/api/me', as(cookie));
  assert.equal(me.json.user.role, 'admin');
  for (const page of ['/dashboard', '/business', '/bookings', '/customers', '/analytics', '/officials']) {
    assert.equal((await s.get(page, { headers: { cookie, ...HTML_ASK } })).status, 200, page);
  }
  for (const url of ['/api/dashboard/all-bookings', '/api/dashboard/customers', '/api/dashboard/overview', '/api/dashboard/export.csv', '/api/dashboard/officials', '/api/dashboard/connection']) {
    assert.equal((await s.get(url, as(cookie))).status, 200, url);
  }
});

test('the second admin sees every booking and customer, and can cancel and refund a customer booking', async (t) => {
  const s = await site(t);
  const asha = await signUp(s, 'Asha Verma', 'asha@example.com');
  const booking = await bookPaid(s, asha, 'pay_extra_1');
  const cookie = cookieOf(await adminLogin(s));

  const all = (await s.get('/api/dashboard/all-bookings', as(cookie))).json;
  assert.ok(all.rows.some((r) => r.ref === booking.ref), 'the customer booking is listed');
  // the admin login is not a customer
  const customers = (await s.get('/api/dashboard/customers', as(cookie))).json;
  assert.deepEqual(customers.rows.map((r) => r.email), ['asha@example.com']);

  const done = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(cookie));
  assert.equal(done.status, 200, done.text);
  assert.equal(s.store.bookings.find((b) => b.ref === booking.ref).status, 'refunded');
});

test('the second admin can create and remove official logins like the owner', async (t) => {
  const s = await site(t);
  const cookie = cookieOf(await adminLogin(s));
  const made = await s.post('/api/dashboard/officials', { name: 'R. K. Sharma', office: 'Municipal Corporation', email: 'rk@gov.example.in', password: 'official-pass-1' }, as(cookie));
  assert.equal(made.status, 201, made.text);
  const id = (await s.get('/api/dashboard/officials', as(cookie))).json.officials[0].id;
  assert.equal((await s.post(`/api/dashboard/officials/${id}/remove`, {}, as(cookie))).status, 200);
});

test('a wrong password is refused, and the operator login still works beside it', async (t) => {
  const s = await site(t);
  assert.equal((await adminLogin(s, 'not-the-password')).status, 401);
  assert.equal((await adminLogin(s, EXTRA.EXTRA_ADMIN_PASSWORD, 'someone.else@example.com')).status, 401);
  const op = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(op.status, 200);
  assert.equal(op.json.user.role, 'admin');
  assert.equal(op.json.user.email, null);
  assert.equal((await s.get('/api/dashboard/all-bookings', as(cookieOf(op)))).status, 200);
});

test('nobody can sign up as the admin, and an admin email cannot be used to sign up again', async (t) => {
  const s = await site(t);
  const again = await s.post('/api/auth/signup', { name: 'Someone', email: EXTRA.EXTRA_ADMIN_EMAIL, password: 'a-good-password' });
  assert.equal(again.status, 409);
  const asha = await signUp(s, 'Asha Verma', 'asha@example.com');
  assert.equal((await s.get('/api/dashboard/all-bookings', as(asha))).status, 403);
  assert.equal((await s.get('/api/dashboard/customers', as(asha))).status, 403);
});

test('without the settings, or with half of them, there is no second admin', async (t) => {
  const none = await site(t, {});
  assert.equal((await adminLogin(none)).status, 401);
  const half = await site(t, { EXTRA_ADMIN_EMAIL: EXTRA.EXTRA_ADMIN_EMAIL });
  assert.equal((await adminLogin(half)).status, 401);
  const weak = await site(t, { EXTRA_ADMIN_EMAIL: EXTRA.EXTRA_ADMIN_EMAIL, EXTRA_ADMIN_PASSWORD: 'password' });
  assert.equal((await adminLogin(weak, 'password')).status, 401);
});

test('a customer who already has that email becomes the admin and keeps the account id', async (t) => {
  const first = await makeSite({ razorpayKeys: true, env: { ...OP } });
  const signed = await first.post('/api/auth/signup', { name: 'Akshat', email: 'second.admin@example.com', password: 'a-good-password' });
  assert.equal(signed.status, 201);
  const dir = first.dir;
  await first.close();

  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...EXTRA }, existingDir: dir });
  t.after(() => s.close());
  assert.equal((await adminLogin(s, 'a-good-password')).status, 401, 'the old password no longer works');
  const login = await adminLogin(s);
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.user.role, 'admin');
  assert.equal(s.config.auth.extraAdmin.email, 'second.admin@example.com');
});

test('changing the password signs the admin out; removing the settings makes the account a customer again', async (t) => {
  const first = await makeSite({ razorpayKeys: true, env: { ...OP, ...EXTRA } });
  const cookie = cookieOf(await adminLogin(first));
  assert.equal((await first.get('/api/dashboard/all-bookings', as(cookie))).status, 200);
  const dir = first.dir;
  await first.close();

  const changed = await makeSite({ razorpayKeys: true, env: { ...OP, ...EXTRA, EXTRA_ADMIN_PASSWORD: 'another-admin-pass-2' }, existingDir: dir });
  assert.equal((await changed.get('/api/dashboard/all-bookings', as(cookie))).status, 401, 'the old session is gone');
  assert.equal((await adminLogin(changed)).status, 401, 'the old password is refused');
  const fresh = await adminLogin(changed, 'another-admin-pass-2');
  assert.equal(fresh.status, 200);
  const freshCookie = cookieOf(fresh);
  await changed.close();

  const removed = await makeSite({ razorpayKeys: true, env: { ...OP }, existingDir: dir });
  t.after(() => removed.close());
  assert.equal((await removed.get('/api/dashboard/all-bookings', as(freshCookie))).status, 401, 'the admin session is gone');
  const back = await adminLogin(removed, 'another-admin-pass-2');
  assert.equal(back.status, 200);
  assert.equal(back.json.user.role, 'customer');
});
