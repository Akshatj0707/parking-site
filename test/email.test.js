'use strict';

// When the admin cancels (and refunds) a paid booking, the customer gets an email. The email service is faked here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSite, pay, car } = require('./helpers');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const MAIL = { EMAIL_API_KEY: 'test-email-key-123', EMAIL_FROM: 'owner@example.com', EMAIL_FROM_NAME: 'Bayfind Test' };
const JSON_ASK = { accept: 'application/json' };

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie) => ({ headers: { cookie, ...JSON_ASK } });

// A pretend email service: remembers every request, answers with `reply`.
function fakeMailService(reply = { ok: true, status: 201 }) {
  const calls = [];
  const state = { reply, throwError: null };
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (state.throwError) throw state.throwError;
    return { ok: state.reply.ok, status: state.reply.status, text: async () => state.reply.text || '' };
  };
  return { calls, state, fetchImpl };
}

// The words of a sent message with the tags taken out, whichever service it went to.
const plain = (call) => String(call.body.htmlContent || call.body.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function site(t, { env = MAIL, mail } = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...env }, mail });
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
async function bookPaid(s, cookie, paymentId = 'pay_mail_1') {
  const created = await s.post('/api/bookings', car(), cookie ? { headers: { cookie } } : undefined);
  assert.equal(created.status, 201, created.text);
  assert.equal((await pay(s, created, paymentId)).status, 200);
  return created.json.booking;
}

test('cancelling a paid booking emails the customer through Brevo, and says so under the booking', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { mail: { fetchImpl: mail.fetchImpl } });
  const booking = await bookPaid(s, await customer(s));
  const done = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(await admin(s)));

  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.email, 'sent');
  assert.match(done.json.message, /An email about it was sent to a\*\*\*@example\.com\./);
  assert.ok(!done.text.includes('asha.verma'), 'the whole address is not repeated to the page');
  assert.equal(mail.calls.length, 1);
  const call = mail.calls[0];
  assert.equal(call.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(call.headers['api-key'], MAIL.EMAIL_API_KEY);
  assert.deepEqual(call.body.to, [{ email: 'asha.verma@example.com' }]);
  assert.deepEqual(call.body.sender, { name: 'Bayfind Test', email: 'owner@example.com' });
  assert.match(call.body.subject, new RegExp(`${booking.ref} was cancelled and refunded`));
  assert.match(plain(call), /Hello Asha,/);
  assert.match(plain(call), new RegExp(`Reference ${booking.ref}`));
  assert.equal(call.body.textContent, undefined, 'Brevo gets one content field');
  assert.match(plain(call), /being refunded to the payment method you used/);
  assert.match(plain(call), /rfnd_/, 'the refund number is in it');
  assert.ok(!JSON.stringify(call.body).includes(MAIL.EMAIL_API_KEY), 'the key is never put in the message');
});

test('Resend works the same way', async (t) => {
  const mail = fakeMailService({ ok: true, status: 200 });
  const s = await site(t, { env: { ...MAIL, EMAIL_PROVIDER: 'resend' }, mail: { fetchImpl: mail.fetchImpl } });
  const booking = await bookPaid(s, await customer(s));
  const done = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(await admin(s)));
  assert.equal(done.json.email, 'sent');
  assert.equal(mail.calls[0].url, 'https://api.resend.com/emails');
  assert.equal(mail.calls[0].headers.authorization, `Bearer ${MAIL.EMAIL_API_KEY}`);
  assert.equal(mail.calls[0].body.from, 'Bayfind Test <owner@example.com>');
  assert.deepEqual(mail.calls[0].body.to, ['asha.verma@example.com']);
});

test('without email settings the cancellation still works and the admin is told no email went', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { env: {}, mail: { fetchImpl: mail.fetchImpl } });
  const booking = await bookPaid(s, await customer(s));
  const done = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(await admin(s)));
  assert.equal(done.status, 200);
  assert.equal(done.json.email, 'not_set_up');
  assert.match(done.json.message, /No email was sent: email is not set up on this site \(add EMAIL_API_KEY and EMAIL_FROM in Render\)/);
  assert.equal(mail.calls.length, 0);
  assert.equal(s.store.bookings.find((b) => b.ref === booking.ref).status, 'refunded');
});

test('half of the settings (a key but no sender) is the same as none', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { env: { EMAIL_API_KEY: MAIL.EMAIL_API_KEY }, mail: { fetchImpl: mail.fetchImpl } });
  const booking = await bookPaid(s, await customer(s));
  const done = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(await admin(s)));
  assert.equal(done.json.email, 'not_set_up');
  assert.equal(mail.calls.length, 0);
});

test('if the email service refuses or cannot be reached, the booking is still cancelled and refunded', async (t) => {
  const mail = fakeMailService({ ok: false, status: 401, text: '{"message":"Key not found"}' });
  const s = await site(t, { mail: { fetchImpl: mail.fetchImpl } });
  const cookie = await admin(s);
  const first = await bookPaid(s, await customer(s), 'pay_mail_a');
  const refused = await s.post(`/api/dashboard/bookings/${first.ref}/cancel`, {}, as(cookie));
  assert.equal(refused.status, 200, refused.text);
  assert.equal(refused.json.email, 'failed');
  assert.match(refused.json.message, /could not be sent \(Brevo answered HTTP 401\)\. Tell the customer yourself\./);
  assert.ok(!refused.text.includes(MAIL.EMAIL_API_KEY));
  assert.equal(s.store.bookings.find((b) => b.ref === first.ref).status, 'refunded');

  mail.state.throwError = new Error('socket hang up');
  const second = await bookPaid(s, await customer(s, 'Ravi Kumar', 'ravi@example.com'), 'pay_mail_b');
  const down = await s.post(`/api/dashboard/bookings/${second.ref}/cancel`, {}, as(cookie));
  assert.equal(down.status, 200);
  assert.equal(down.json.email, 'failed');
  assert.match(down.json.message, /Brevo could not be reached/);
});

test('a booking made without an account has no customer email, so nothing is sent', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { mail: { fetchImpl: mail.fetchImpl } });
  const booking = await bookPaid(s, null);
  const done = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(await admin(s)));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.email, 'no_email');
  assert.match(done.json.message, /no customer email/);
  assert.equal(mail.calls.length, 0);
});

test('a failed refund emails a "cancelled, refund not sent yet" notice, and the retry emails the refund', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { mail: { fetchImpl: mail.fetchImpl } });
  const cookie = await admin(s);
  const booking = await bookPaid(s, await customer(s));

  s.fake.state.failRefunds = true;
  const failed = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(cookie));
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.json.email, 'sent');
  assert.equal(mail.calls.length, 1);
  assert.match(mail.calls[0].body.subject, /was cancelled$/);
  assert.match(plain(mail.calls[0]), /could not send the refund/);
  assert.ok(!/being refunded to the payment method/.test(plain(mail.calls[0])), 'it does not claim a refund that did not happen');

  s.fake.state.failRefunds = false;
  const again = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(cookie));
  assert.equal(again.status, 200, again.text);
  assert.equal(mail.calls.length, 2);
  assert.match(mail.calls[1].body.subject, /cancelled and refunded/);
});

test('a customer cannot cancel, and no email goes out for a refused request', async (t) => {
  const mail = fakeMailService();
  const s = await site(t, { mail: { fetchImpl: mail.fetchImpl } });
  const cookie = await customer(s);
  const booking = await bookPaid(s, cookie);
  const refused = await s.post(`/api/dashboard/bookings/${booking.ref}/cancel`, {}, as(cookie));
  assert.equal(refused.status, 403);
  assert.equal(mail.calls.length, 0);
  assert.equal(s.store.bookings.find((b) => b.ref === booking.ref).status, 'paid');
});
