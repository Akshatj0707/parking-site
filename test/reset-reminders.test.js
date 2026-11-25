'use strict';

// Two things that need email: a customer who forgot the password gets a link to choose a new one, and a parked customer gets
// a reminder a few minutes before the booked end. Email goes through a pretend Brevo (the test records each message).
// The clock starts at 10:00 on Wed 14 Oct 2026 (lot time); the default booking is 11:00 to 13:00.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { makeSite, pay, car, MINUTE } = require('./helpers');
const { loadConfig } = require('../src/config');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const MAIL = { EMAIL_API_KEY: 'test-email-key-123', EMAIL_FROM: 'owner@example.com', EMAIL_FROM_NAME: 'Bayfind Test' };
const SITE = 'https://parking.example.test';
const JSON_ASK = { accept: 'application/json' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line && !line.startsWith('bf_session=;') ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

// A pretend email service. `fail` makes it answer with an error.
function fakeMailService() {
  const calls = [];
  const state = { fail: false };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (state.fail) return { ok: false, status: 500, text: async () => 'boom' };
    calls.push({ to: body.to[0].email, subject: body.subject, html: body.htmlContent });
    return { ok: true, status: 201, text: async () => '' };
  };
  return { calls, state, fetchImpl };
}

// The email goes out in the background after the answer: wait for it.
async function waitFor(check, what = 'the email') {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`${what} was never sent`);
}

async function site(t, { env = {}, mail = true, ...options } = {}) {
  const svc = fakeMailService();
  const s = await makeSite({ razorpayKeys: true, ...options, env: { ...OP, ...(mail ? MAIL : {}), ...env }, ...(mail ? { mail: { fetchImpl: svc.fetchImpl } } : {}) });
  t.after(() => s.close());
  s.mailbox = svc;
  return s;
}

async function customer(s, name = 'Asha Verma', email = 'asha.verma@example.com', password = 'a-good-password') {
  const r = await s.post('/api/auth/signup', { name, email, password });
  assert.equal(r.status, 201, r.text);
  return cookieOf(r);
}

const linkIn = (message) => {
  const m = /href="([^"]*\/reset-password\?t=[^"]+)"/.exec(message.html);
  assert.ok(m, 'the email holds a reset link');
  return m[1];
};
const tokenOf = (link) => new URL(link).searchParams.get('t');
const forgot = (s, email, extra) => s.post('/api/auth/forgot', { email }, { headers: JSON_ASK, ...(extra || {}) });
const reset = (s, token, password) => s.post('/api/auth/reset', { t: token, password }, { headers: JSON_ASK });

// ===== A forgotten password ========================================================================

test('the link time comes from the settings and stays within sensible limits', () => {
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x' }).auth.resetMinutes, 30);
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', RESET_LINK_MINUTES: '1' }).auth.resetMinutes, 5);
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', RESET_LINK_MINUTES: '99999' }).auth.resetMinutes, 240);
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', END_REMINDER_MINUTES: '0' }).reminder.minutes, 0);
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x' }).reminder.minutes, 15);
});

test('a customer who forgot the password gets a link, sets a new password once, and is signed in', async (t) => {
  const s = await site(t, { env: { PUBLIC_URL: SITE } });
  await customer(s);
  const asked = await forgot(s, 'Asha.Verma@Example.com');
  assert.equal(asked.status, 200, asked.text);
  assert.match(asked.json.message, /30 minutes and only once/);
  await waitFor(() => s.mailbox.calls.length === 1);
  const mail = s.mailbox.calls[0];
  assert.equal(mail.to, 'asha.verma@example.com');
  assert.match(mail.subject, /Set a new password/);
  const link = linkIn(mail);
  assert.ok(link.startsWith(SITE + '/reset-password?t='), 'the address of the site, not of the request');

  const weak = await reset(s, tokenOf(link), 'short');
  assert.equal(weak.status, 400, 'a weak password is refused');
  const done = await reset(s, tokenOf(link), 'a-brand-new-password');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.next, '/account');
  const fresh = cookieOf(done);
  assert.equal((await s.get('/api/me', as(fresh))).json.user.name, 'Asha Verma');

  assert.equal((await s.post('/api/auth/login', { identifier: 'asha.verma@example.com', password: 'a-good-password' })).status, 401, 'the old password is gone');
  assert.equal((await s.post('/api/auth/login', { identifier: 'asha.verma@example.com', password: 'a-brand-new-password' })).status, 200);
  const again = await reset(s, tokenOf(link), 'yet-another-password');
  assert.equal(again.status, 400, 'the link works once');
  assert.equal(again.json.error, 'bad_reset_link');
});

test('the answer is the same for every address, and only real customers get an email', async (t) => {
  const s = await site(t, { env: { EXTRA_ADMIN_EMAIL: 'boss@example.com', EXTRA_ADMIN_PASSWORD: 'boss-password-1' } });
  await customer(s);
  const known = await forgot(s, 'asha.verma@example.com');
  const unknown = await forgot(s, 'nobody@example.com');
  const admin = await forgot(s, 'boss@example.com');
  assert.deepEqual([known.status, unknown.status, admin.status], [200, 200, 200]);
  assert.deepEqual(unknown.json, known.json);
  assert.deepEqual(admin.json, known.json);
  await waitFor(() => s.mailbox.calls.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.mailbox.calls.map((m) => m.to), ['asha.verma@example.com'], 'no email for an unknown address or for the admin');
  assert.equal((await forgot(s, 'not an email')).status, 400);
});

test('a link stops working after its time, and a changed or borrowed link is refused', async (t) => {
  const s = await site(t, { env: { PUBLIC_URL: SITE } });
  await customer(s);
  const ravi = await customer(s, 'Ravi Kumar', 'ravi.kumar@example.com');
  await forgot(s, 'asha.verma@example.com');
  await forgot(s, 'ravi.kumar@example.com');
  await waitFor(() => s.mailbox.calls.length === 2);
  const asha = tokenOf(linkIn(s.mailbox.calls[0]));
  const other = tokenOf(linkIn(s.mailbox.calls[1]));

  const [id, exp, sig] = asha.split('.');
  assert.equal((await reset(s, `${id}.${exp}.${'A'.repeat(sig.length)}`, 'a-brand-new-password')).status, 400, 'a made-up signature');
  assert.equal((await reset(s, `${id}.${Number(exp) + 3600000}.${sig}`, 'a-brand-new-password')).status, 400, 'a longer time');
  assert.equal((await reset(s, `${other.split('.')[0]}.${exp}.${sig}`, 'a-brand-new-password')).status, 400, "somebody else's account");
  assert.equal((await reset(s, 'nonsense', 'a-brand-new-password')).status, 400);
  assert.equal((await reset(s, '', 'a-brand-new-password')).status, 400);

  s.advance(31 * MINUTE);
  const late = await reset(s, asha, 'a-brand-new-password');
  assert.equal(late.status, 400);
  assert.match(late.json.message, /expired or was already used/);
  assert.equal((await s.get('/api/me', as(ravi))).json.user.name, 'Ravi Kumar', 'nobody was changed by the failed tries');
});

test('a new password signs the customer out on every other device', async (t) => {
  const s = await site(t);
  const phone = await customer(s);
  assert.equal((await s.get('/api/me', as(phone))).json.user.email, 'asha.verma@example.com');
  await forgot(s, 'asha.verma@example.com');
  await waitFor(() => s.mailbox.calls.length === 1);
  const done = await reset(s, tokenOf(linkIn(s.mailbox.calls[0])), 'a-brand-new-password');
  assert.equal((await s.get('/api/me', as(phone))).json.user, null, 'the old sign-in no longer works');
  assert.equal((await s.get('/api/me', as(cookieOf(done)))).json.user.email, 'asha.verma@example.com');
});

test('only three reset emails an hour go to one address, and the site never says so', async (t) => {
  const s = await site(t);
  await customer(s);
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push((await forgot(s, 'asha.verma@example.com')).json.message);
  await waitFor(() => s.mailbox.calls.length === 3);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.mailbox.calls.length, 3);
  assert.equal(new Set(answers).size, 1, 'the same words every time');
  s.advance(61 * MINUTE);
  await forgot(s, 'asha.verma@example.com');
  await waitFor(() => s.mailbox.calls.length === 4);
});

test('without email, or without a site address, no reset email is sent and the page says why', async (t) => {
  const none = await site(t, { mail: false });
  await customer(none);
  const r = await forgot(none, 'asha.verma@example.com');
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'email_not_set_up');
  assert.equal((await none.get('/api/config')).json.auth.passwordReset, false);

  const s = await site(t);
  assert.equal((await s.get('/api/config')).json.auth.passwordReset, true);
  await customer(s);
  // an address from the request is trusted only for a computer's own address, never a name a visitor can choose
  const { port } = new URL(s.base);
  const forged = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ email: 'asha.verma@example.com' });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/forgot', method: 'POST', headers: { Host: 'evil.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(forged.status, 503, JSON.stringify(forged.json));
  assert.equal(forged.json.error, 'site_address_unknown');
  assert.equal(s.mailbox.calls.length, 0);
});

test('the reset pages exist, are kept out of caches and send no referrer', async (t) => {
  const s = await site(t);
  const ask = await s.get('/forgot-password');
  assert.equal(ask.status, 200);
  const page = await s.get('/reset-password?t=abc');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('cache-control'), /no-store/);
});

test('a reset request from another website is refused', async (t) => {
  const s = await site(t);
  await customer(s);
  const r = await forgot(s, 'asha.verma@example.com', { headers: { ...JSON_ASK, 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal(s.mailbox.calls.length, 0);
});

// ===== The "your parking ends soon" reminder ========================================================

const clockAt = (s, hh, mm) => {
  s.clock.t = Date.UTC(2026, 9, 14, hh, mm) - 330 * MINUTE;
};
const reminders = (s) => s.app.locals.reminders;
const gateOf = (s) => s.app.locals.gate;

async function adminCookie(s) {
  const r = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  return cookieOf(r);
}

// A paid 11:00 to 13:00 booking for a signed-in customer, scanned in at 10:50.
async function parked(s, { signedIn = true, over = {} } = {}) {
  const cookie = signedIn ? await customer(s) : null;
  const created = await s.post('/api/bookings', car(over), cookie ? { headers: { cookie } } : undefined);
  assert.equal(created.status, 201, created.text);
  const paid = await pay(s, created, 'pay_' + Math.random().toString(16).slice(2, 8));
  const booking = s.store.bookings.find((b) => b.ref === paid.json.booking.ref);
  clockAt(s, 10, 50);
  const scan = await s.post('/api/dashboard/gate/scan', { token: gateOf(s).tokenFor('in', booking) }, as(await adminCookie(s)));
  assert.equal(scan.json.outcome, 'entered', scan.text);
  return { booking, cookie };
}

test('a parked customer gets one reminder 15 minutes before the end, with a link to add time', async (t) => {
  const s = await site(t, { env: { PUBLIC_URL: SITE } });
  const { booking } = await parked(s);

  clockAt(s, 12, 30); // 30 minutes to go: too early
  assert.equal(await reminders(s).run(), 0);
  clockAt(s, 12, 46); // 14 minutes to go
  assert.equal(await reminders(s).run(), 1);
  assert.equal(s.mailbox.calls.length, 1);
  const m = s.mailbox.calls[0];
  assert.equal(m.to, 'asha.verma@example.com');
  assert.equal(m.subject, 'Your parking ends at 1:00 pm');
  assert.match(m.html, /in about 14 minutes/);
  assert.match(m.html, /add up to 4 more hours/);
  assert.match(m.html, /₹40 an hour/);
  assert.ok(m.html.includes(`href="${SITE}${gateOf(s).passPath(booking)}"`), 'the link opens the pass page');

  clockAt(s, 12, 50);
  assert.equal(await reminders(s).run(), 0, 'only once');
  assert.equal(s.mailbox.calls.length, 1);
});

test('a customer who adds time gets a new reminder for the new end', async (t) => {
  const s = await site(t, { env: { PUBLIC_URL: SITE } });
  const { booking } = await parked(s);
  clockAt(s, 12, 46);
  assert.equal(await reminders(s).run(), 1);
  // pays for one more hour (a pretend order, settled directly)
  const g = gateOf(s);
  const started = await s.post('/api/pass/extend/start', { t: new URL('http://x' + g.passPath(booking)).searchParams.get('t'), hours: 1 });
  assert.equal(started.status, 200, started.text);
  await g.settleExtension(booking, booking.extensions[0], 'pay_more');
  assert.equal(booking.hours, 3);
  clockAt(s, 13, 20); // 40 minutes left of the new end at 2:00 pm
  assert.equal(await reminders(s).run(), 0);
  clockAt(s, 13, 50);
  assert.equal(await reminders(s).run(), 1);
  assert.equal(s.mailbox.calls[1].subject, 'Your parking ends at 2:00 pm');
});

test('no reminder when nobody is parked, the vehicle left, there is no account email, or the reminder is off', async (t) => {
  // not scanned in
  const a = await site(t);
  const cookie = await customer(a);
  const created = await a.post('/api/bookings', car(), { headers: { cookie } });
  await pay(a, created, 'pay_a');
  clockAt(a, 12, 50);
  assert.equal(await reminders(a).run(), 0);

  // left before the reminder time
  const b = await site(t);
  const left = await parked(b);
  clockAt(b, 11, 40);
  const out = await b.post('/api/dashboard/gate/scan', { token: gateOf(b).tokenFor('out', left.booking) }, as(await adminCookie(b)));
  assert.equal(out.json.outcome, 'exited', out.text);
  clockAt(b, 12, 50);
  assert.equal(await reminders(b).run(), 0);

  // booked without an account
  const c = await site(t, { env: { CUSTOMER_LOGIN_REQUIRED: 'off' } });
  await parked(c, { signedIn: false });
  clockAt(c, 12, 50);
  assert.equal(await reminders(c).run(), 0);

  // switched off, and email not set up
  const d = await site(t, { env: { END_REMINDER_MINUTES: '0' } });
  await parked(d);
  clockAt(d, 12, 50);
  assert.equal(await reminders(d).run(), 0);
  const e = await site(t, { mail: false });
  await parked(e);
  clockAt(e, 12, 50);
  assert.equal(await reminders(e).run(), 0);
  assert.equal(a.mailbox.calls.length + b.mailbox.calls.length + c.mailbox.calls.length + d.mailbox.calls.length, 0);
});

test('a reminder that cannot be sent is tried again, three times at most', async (t) => {
  const s = await site(t);
  const { booking } = await parked(s);
  clockAt(s, 12, 46);
  s.mailbox.state.fail = true;
  for (let i = 0; i < 5; i++) assert.equal(await reminders(s).run(), 0);
  assert.equal(booking.endReminderTries, 3, 'then it gives up');
  s.mailbox.state.fail = false;
  assert.equal(await reminders(s).run(), 0, 'it does not start again for the same end time');
  assert.equal(s.mailbox.calls.length, 0);
});

test('with a parked customer and no site address the reminder still goes, pointing to My bookings', async (t) => {
  const s = await site(t);
  await parked(s);
  clockAt(s, 12, 46);
  assert.equal(await reminders(s).run(), 1);
  assert.match(s.mailbox.calls[0].html, /open My bookings/);
  assert.equal(s.mailbox.calls[0].html.includes('/pass?t='), false);
});
