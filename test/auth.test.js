'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeSite, bookAndPay, car, basic } = require('./helpers');

async function stop(site) {
  site.server.closeAllConnections();
  await new Promise((resolve) => site.server.close(resolve));
}

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const ME = { name: 'Asha Verma', email: 'Asha.Verma@Example.com', password: 'a-good-password' };
const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const withCookie = (cookie, extra = {}) => ({ headers: { cookie, ...extra } });
const BROWSER_PAGE = { accept: 'text/html,application/xhtml+xml' };

async function signUp(site, body = ME) {
  const r = await site.post('/api/auth/signup', body);
  return { r, cookie: cookieOf(r) };
}

test('a customer can sign up, and is then signed in as a customer', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const anon = await site.get('/api/me');
  assert.deepEqual(anon.json, { user: null });

  const { r, cookie } = await signUp(site);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.user, { role: 'customer', name: 'Asha Verma', email: 'asha.verma@example.com', permissions: ['booking:create', 'booking:view-own'] });
  assert.equal(r.json.next, '/account');
  const flags = r.headers.getSetCookie()[0];
  assert.match(flags, /HttpOnly/);
  assert.match(flags, /SameSite=Lax/);
  assert.match(flags, /Path=\//);

  const me = await site.get('/api/me', withCookie(cookie));
  assert.equal(me.json.user.role, 'customer');
  assert.equal(me.json.user.email, 'asha.verma@example.com');
});

test('passwords are stored only as hashes, and sign-up refuses bad input and a second account with the same email', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  assert.equal((await signUp(site)).r.status, 201);
  const file = fs.readFileSync(path.join(site.dir, 'users.json'), 'utf8');
  assert.ok(!file.includes(ME.password), 'the password is not in the file');
  assert.match(JSON.parse(file).users[0].pass, /^s1\$/);

  assert.equal((await site.post('/api/auth/signup', { ...ME, email: 'ASHA.verma@example.com' })).json.error, 'email_taken');
  assert.equal((await site.post('/api/auth/signup', { ...ME, email: 'not-an-email' })).json.error, 'invalid_email');
  assert.equal((await site.post('/api/auth/signup', { ...ME, email: 'b@example.com', password: 'short' })).json.error, 'weak_password');
  assert.equal((await site.post('/api/auth/signup', { ...ME, email: 'b@example.com', password: 'password123' })).json.error, 'weak_password');
  assert.equal((await site.post('/api/auth/signup', { ...ME, email: 'b@example.com', name: '   ' })).json.error, 'invalid_name');
  assert.equal((await site.post('/api/auth/signup', { ...ME, email: 'b@example.com', name: '<script>' })).json.error, 'invalid_name');
});

test('sign in with the right password works, a wrong one does not, and sign out ends the session', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  await signUp(site);

  const wrong = await site.post('/api/auth/login', { identifier: ME.email, password: 'not the password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'bad_login');
  assert.equal(cookieOf(wrong), null);
  const unknown = await site.post('/api/auth/login', { identifier: 'nobody@example.com', password: 'whatever-it-is' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.message, wrong.json.message, 'an unknown email and a wrong password look the same');

  const ok = await site.post('/api/auth/login', { identifier: '  ASHA.VERMA@example.com ', password: ME.password });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.next, '/account');
  const cookie = cookieOf(ok);
  assert.equal((await site.get('/api/me', withCookie(cookie))).json.user.name, 'Asha Verma');

  const out = await site.post('/api/auth/logout', {}, withCookie(cookie));
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
});

test('after 10 wrong passwords for one account the account is paused, even for the right password', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  await signUp(site);
  for (let i = 0; i < 10; i++) {
    assert.equal((await site.post('/api/auth/login', { identifier: ME.email, password: 'guess' + i })).status, 401);
  }
  const locked = await site.post('/api/auth/login', { identifier: ME.email, password: ME.password });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  site.advance(16 * 60 * 1000);
  assert.equal((await site.post('/api/auth/login', { identifier: ME.email, password: ME.password })).status, 200);
});

test('the operator signs in as ADMIN with the operator password, and nobody can sign up as an admin', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const bad = await site.post('/api/auth/login', { identifier: 'operator', password: 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await site.post('/api/auth/login', { identifier: 'Operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'admin');
  assert.equal(ok.json.next, '/dashboard');
  const cookie = cookieOf(ok);

  const dash = await site.get('/api/dashboard', withCookie(cookie));
  assert.equal(dash.status, 200, 'the admin cookie opens the dashboard without the Basic password');
  assert.equal((await site.get('/api/dashboard/analytics', withCookie(cookie))).status, 200);
  assert.equal((await site.get('/dashboard', withCookie(cookie, BROWSER_PAGE))).status, 200);
  assert.equal((await site.get('/analytics', withCookie(cookie, BROWSER_PAGE))).status, 200);

  // there is no way to create an admin: the operator user name is not an email, so it cannot be signed up
  assert.equal((await site.post('/api/auth/signup', { name: 'Op', email: 'operator', password: 'a-good-password' })).json.error, 'invalid_email');
  const customer = await signUp(site, { name: 'Op', email: 'operator@example.com', password: 'a-good-password' });
  assert.equal((await site.get('/api/me', withCookie(customer.cookie))).json.user.role, 'customer');
});

test('a customer cannot open the operator pages or call the operator API (403), and a visitor is sent to sign in', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const { cookie } = await signUp(site);

  for (const url of ['/api/dashboard', '/api/dashboard/analytics', '/api/dashboard/connection', '/api/dashboard/bookings?plate=MP09AB1234']) {
    const r = await site.get(url, withCookie(cookie, { accept: 'application/json' }));
    assert.equal(r.status, 403, url);
    assert.equal(r.json.error, 'forbidden');
  }
  const cancel = await site.post('/api/dashboard/bookings/ABCDEFGH/cancel', {}, withCookie(cookie, { accept: 'application/json' }));
  assert.equal(cancel.status, 403);
  const sample = await site.post('/api/dashboard/sample-data', { action: 'add' }, withCookie(cookie, { accept: 'application/json' }));
  assert.equal(sample.status, 403);
  for (const page of ['/dashboard', '/analytics']) {
    const r = await site.get(page, withCookie(cookie, BROWSER_PAGE));
    assert.equal(r.status, 403, page);
    assert.match(r.text, /Operators only/);
  }

  // a visitor who is not signed in: a browser is sent to the sign-in page, the page's own requests get a plain answer
  const redirect = await site.get('/dashboard', { headers: BROWSER_PAGE, redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/login?next=%2Fdashboard');
  const json = await site.get('/api/dashboard', { headers: { accept: 'application/json' } });
  assert.equal(json.status, 401);
  assert.equal(json.json.error, 'login_required');
  assert.equal(json.headers.get('www-authenticate'), null, 'no browser password box for the page\'s own requests');
  // scripts keep the classic challenge
  const script = await site.get('/api/dashboard');
  assert.equal(script.status, 401);
  assert.match(script.headers.get('www-authenticate'), /^Basic/);
  assert.equal((await site.get('/api/dashboard', { headers: { authorization: basic('operator', OP.OPERATOR_PASSWORD) } })).status, 200);
});

test('a forged, tampered or expired sign-in cookie is ignored', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const { cookie } = await signUp(site);
  const [name, value] = cookie.split('=');
  const [payload, sig] = value.split('.');

  const forgedPayload = Buffer.from(JSON.stringify({ r: 'admin', u: null, e: Date.now() + 1e9, p: 'x' })).toString('base64url');
  for (const bad of [`${name}=${forgedPayload}.${sig}`, `${name}=${payload}.${sig.slice(0, -2)}AA`, `${name}=${payload}`, `${name}=garbage`, `${name}=.`]) {
    assert.equal((await site.get('/api/me', withCookie(bad))).json.user, null, bad);
    assert.equal((await site.get('/api/dashboard', withCookie(bad, { accept: 'application/json' }))).status, 401);
  }
  assert.equal((await site.get('/api/me', withCookie(cookie))).json.user.role, 'customer');
  site.advance(15 * 24 * 60 * 60 * 1000);
  assert.equal((await site.get('/api/me', withCookie(cookie))).json.user, null, 'a customer session ends after 14 days');
});

test('an admin session ends when the operator password changes', async (t) => {
  const first = await makeSite({ env: OP });
  const login = await first.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  const cookie = cookieOf(login);
  const dir = first.dir;
  await stop(first);
  const second = await makeSite({ env: { OPERATOR_PASSWORD: 'a different password' }, existingDir: dir });
  t.after(async () => {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await second.get('/api/dashboard', withCookie(cookie, { accept: 'application/json' }))).status, 401);
});

test('sign-in requests must come from this site\'s own pages', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const cross = await site.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const other = await site.post('/api/auth/signup', ME, { headers: { origin: 'https://evil.example' } });
  assert.equal(other.status, 403);
  const form = await site.post('/api/auth/login', undefined, { raw: 'identifier=operator&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 403);
});

test('when sign-in is required, only a signed-in customer can book, and the booking is theirs alone', async (t) => {
  const site = await makeSite({ env: { ...OP, CUSTOMER_LOGIN_REQUIRED: 'on' } });
  t.after(() => site.close());
  const config = await site.get('/api/config');
  assert.equal(config.json.auth.loginRequired, true);

  const anon = await site.post('/api/bookings', car());
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error, 'login_required');

  const mine = await signUp(site);
  const res = await site.post('/api/bookings', car(), withCookie(mine.cookie));
  assert.equal(res.status, 201);
  const id = res.json.booking.id;
  assert.match(site.store.get(id).customerId, /^usr_[0-9a-f]{12}$/);
  const paid = await site.post('/api/payments/demo-confirm', { bookingId: id });
  assert.equal(paid.status, 200);

  const list = await site.get('/api/account/bookings', withCookie(mine.cookie));
  assert.equal(list.status, 200);
  assert.equal(list.json.bookings.length, 1);
  assert.equal(list.json.bookings[0].state, 'upcoming');
  assert.equal(list.json.bookings[0].plate, 'MP 09 AB 1234');
  assert.equal(list.json.bookings[0].amount, 80);

  const other = await signUp(site, { name: 'Ravi', email: 'ravi@example.com', password: 'another-good-one' });
  assert.deepEqual((await site.get('/api/account/bookings', withCookie(other.cookie))).json.bookings, [], 'another customer sees none of it');
  assert.equal((await site.get('/api/account/bookings')).status, 401);
  const admin = cookieOf(await site.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD }));
  assert.equal((await site.get('/api/account/bookings', withCookie(admin))).status, 403);
});

test('the browser cannot choose whose booking it is', async (t) => {
  const site = await makeSite({ env: { ...OP, CUSTOMER_LOGIN_REQUIRED: 'on' } });
  t.after(() => site.close());
  const a = await signUp(site);
  const b = await signUp(site, { name: 'Ravi', email: 'ravi@example.com', password: 'another-good-one' });
  assert.ok(b.cookie);
  const users = site.app.locals.auth.users;
  const ravi = users.byEmail('asha.verma@example.com') && users.byEmail('ravi@example.com').id;
  const res = await site.post('/api/bookings', { ...car(), customerId: ravi }, withCookie(a.cookie));
  assert.equal(res.status, 201);
  assert.notEqual(site.store.get(res.json.booking.id).customerId, ravi);
  assert.equal(site.store.get(res.json.booking.id).customerId, users.byEmail('asha.verma@example.com').id);
});

test('without the login requirement a guest can still book, and the booking belongs to nobody', async (t) => {
  const site = await makeSite({ env: { ...OP, CUSTOMER_LOGIN_REQUIRED: 'off' } });
  t.after(() => site.close());
  const { created, paid } = await bookAndPay(site, car());
  assert.equal(created.status, 201);
  assert.equal(paid.status, 200);
  assert.equal(site.store.get(created.json.booking.id).customerId, null);
  assert.equal((await site.get('/api/config')).json.auth.loginRequired, false);
});

test('no test account exists on a real site; one is only made when it is asked for, and never once Razorpay keys are set', async (t) => {
  const plain = await makeSite({ env: { ...OP, NODE_ENV: 'production' } });
  t.after(() => plain.close());
  assert.equal((await plain.get('/api/config')).json.auth.testCustomer, null, 'nothing is published on a site in production');
  assert.equal((await plain.post('/api/auth/login', { identifier: 'customer@example.com', password: 'Customer@123' })).status, 401);

  const asked = await makeSite({ env: { ...OP, SEED_TEST_CUSTOMER: 'on' } });
  t.after(() => asked.close());
  const cfg = (await asked.get('/api/config')).json.auth;
  assert.deepEqual(cfg.testCustomer, { email: 'customer@example.com', password: 'Customer@123' });
  const login = await asked.post('/api/auth/login', { identifier: cfg.testCustomer.email, password: cfg.testCustomer.password });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'customer');

  const real = await makeSite({ razorpayKeys: true, env: { ...OP, NODE_ENV: 'production', SEED_TEST_CUSTOMER: 'on' } });
  t.after(() => real.close());
  assert.equal((await real.get('/api/config')).json.auth.testCustomer, null);
  assert.equal((await real.post('/api/auth/login', { identifier: 'customer@example.com', password: 'Customer@123' })).status, 401);
});

test('accounts survive a restart when the data folder does', async (t) => {
  const first = await makeSite({ env: OP });
  const { cookie } = await signUp(first);
  const dir = first.dir;
  await stop(first);
  const second = await makeSite({ env: OP, existingDir: dir });
  t.after(async () => {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await second.get('/api/me', withCookie(cookie))).json.user.name, 'Asha Verma', 'the same cookie still works');
  assert.equal((await second.post('/api/auth/login', { identifier: ME.email, password: ME.password })).status, 200);
});

test('the sign in, sign up and account pages are served, and the footer links to them', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  for (const url of ['/login', '/signup', '/account']) {
    const r = await site.get(url);
    assert.equal(r.status, 200, url);
    assert.match(r.text, /id="auth-root"/);
    assert.match(r.text, /<script src="\/js\/auth\.js">/);
    assert.ok(!/<script>(?!\s*<\/script>)/.test(r.text), 'no inline script');
    assert.match(r.text, /href="\/login">Sign in<\/a>/);
    assert.match(r.text, /href="\/signup">Create account<\/a>/);
  }
});
