'use strict';

// Shared set-up for the tests: a real server on a random port, a temporary data folder,
// a clock the test controls, and a pretend Razorpay that records what the site asks of it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');
const { hmacHex } = require('../src/payments');

const KEY_ID = 'rzp_test_abc123';
const KEY_SECRET = 'test_secret_value_1234';
const WEBHOOK_SECRET = 'whsec_test_value';

// Wednesday 14 October 2026, 10:00 in India (04:30 UTC). The tests move this clock when they need to.
const START = Date.UTC(2026, 9, 14, 4, 30);
const MINUTE = 60 * 1000;

const silentLog = { info() {}, warn() {}, error() {} };

function fakeRazorpay() {
  // refundDelayMs      makes a refund slow, so a test can press the button twice while the first one is in flight
  // fullyRefunded      payment ids that Razorpay already sent back in full (a test can add one to pretend that the
  //                    operator refunded it by hand); a second refund of such a payment is refused like the real one
  // failPaymentFetch   makes "look up this payment" fail
  const state = { failOrders: false, failRefunds: false, failFetch: false, delayMs: 0, refundDelayMs: 0, payments: {}, fullyRefunded: new Set(), failPaymentFetch: false };
  const calls = { orders: [], refunds: [], fetchPayments: [], fetchedPayments: [] };
  let n = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    state,
    calls,
    orders: {
      async create(params) {
        calls.orders.push(params);
        if (state.delayMs) await sleep(state.delayMs);
        if (state.failOrders) throw { statusCode: 401, error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } };
        n += 1;
        return { id: `order_T${String(n).padStart(4, '0')}`, entity: 'order', amount: params.amount, currency: params.currency, receipt: params.receipt, status: 'created' };
      },
      async fetchPayments(orderId) {
        calls.fetchPayments.push(orderId);
        if (state.failFetch) throw new Error('network down');
        const items = state.payments[orderId] || [];
        return { entity: 'collection', count: items.length, items };
      },
    },
    payments: {
      async refund(paymentId, params) {
        calls.refunds.push({ paymentId, ...params });
        if (state.refundDelayMs) await sleep(state.refundDelayMs);
        if (state.failRefunds) throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'Refund not possible right now' } };
        if (state.fullyRefunded.has(paymentId)) throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'The payment has been fully refunded already' } };
        state.fullyRefunded.add(paymentId);
        n += 1;
        return { id: `rfnd_T${String(n).padStart(4, '0')}`, payment_id: paymentId, amount: params.amount };
      },
      async fetch(paymentId) {
        calls.fetchedPayments.push(paymentId);
        if (state.failPaymentFetch) throw new Error('network down');
        const full = state.fullyRefunded.has(paymentId);
        return { id: paymentId, entity: 'payment', status: full ? 'refunded' : 'captured', amount: 8000, amount_refunded: full ? 8000 : 0, refund_status: full ? 'full' : null };
      },
    },
  };
}

// `chat` is for the chat tests: { fetchImpl, apiUrl, timeoutMs } to stand in for Anthropic, and `log` to see what is logged.
async function makeSite({ env = {}, razorpayKeys = false, startAt = START, existingDir, chat, log = silentLog } = {}) {
  const dir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-test-'));
  const keys = razorpayKeys ? { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } : {};
  // Most tests book without an account; the ones about accounts turn this on with env: { CUSTOMER_LOGIN_REQUIRED: 'on' }.
  const config = loadConfig({ DATA_DIR: dir, CUSTOMER_LOGIN_REQUIRED: 'off', ...keys, ...env });
  const clock = { t: startAt };
  const store = new Store(dir);
  const fake = config.razorpay.configured ? fakeRazorpay() : null;
  const app = createApp({ config, store, razorpay: fake, now: () => clock.t, log, chat });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { body, headers = {}, raw, redirect } = {}) => {
    const init = { method, headers: { ...headers } };
    if (redirect) init.redirect = redirect;
    if (raw !== undefined) {
      init.body = raw;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + url, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      // not JSON: pages and plain-text errors
    }
    return { status: res.status, headers: res.headers, text, json };
  };

  return {
    dir,
    config,
    store,
    app,
    bookings: app.locals.bookings,
    server,
    base,
    clock,
    fake,
    get: (url, opts) => call('GET', url, opts),
    post: (url, body, opts) => call('POST', url, { ...opts, body }),
    advance(ms) {
      clock.t += ms;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (!existingDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sign = (orderId, paymentId, secret = KEY_SECRET) => hmacHex(secret, `${orderId}|${paymentId}`);

// What Razorpay Checkout hands back to the browser after a successful payment, sent on to the site.
function pay(site, created, paymentId = 'pay_test1') {
  const orderId = created.json.payment.orderId;
  return site.post('/api/payments/verify', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(orderId, paymentId),
  });
}

// Book and pay in whichever payment mode the site is in.
async function bookAndPay(site, body, paymentId) {
  const created = await site.post('/api/bookings', body);
  if (created.status !== 201) return { created, paid: null };
  const paid = created.json.payment.mode === 'demo'
    ? await site.post('/api/payments/demo-confirm', { bookingId: created.json.booking.id })
    : await pay(site, created, paymentId);
  return { created, paid };
}

// Request bodies. The default time is 11:00 today, an hour after the test clock starts.
const car = (over = {}) => ({ vehicle: 'car', zone: 0, plate: 'MP09AB1234', date: '2026-10-14', time: '11:00', hours: 2, ...over });
const bike = (over = {}) => ({ vehicle: 'bike', zone: 0, plate: 'MP09AB1234', date: '2026-10-14', time: '11:00', hours: 2, ...over });

const AVAILABILITY_URL = (v = 'car', date = '2026-10-14', time = '11:00', hours = 2) =>
  `/api/availability?vehicle=${v}&date=${date}&time=${time}&hours=${hours}`;

function webhookEvent(type, orderId, paymentId, amount = 8000) {
  return { event: type, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured' } } } };
}

// A webhook request exactly as Razorpay sends it: the signature covers the raw bytes of the body.
function signedWebhook(event, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  return { raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmacHex(secret, raw) } };
}

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

// A pretend Anthropic for the chat tests. `fakeClaude(step, step, ...)` answers the first request with the first step, the
// second with the second, and so on (the last step answers any further ones). A step is a function that gets what was
// asked ({ url, method, headers, body }) and returns a Response. `calls` records every request.
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
// What Anthropic sends back: some text (or a list of content blocks) and why it stopped.
const claudeMessage = (content, stopReason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  stop_reason: stopReason,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const claudeSays = (text) => () => json(claudeMessage(text));
const claudeError = (status, type, message) => () => json({ type: 'error', error: { type, message } }, status);
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function fakeClaude(...steps) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    const step = steps[Math.min(n++, steps.length - 1)];
    return step(call);
  };
  return { fetchImpl, calls };
}

// A site whose chat talks to the pretend Anthropic. Close it with t.after.
const AI_KEY = 'sk-ant-test-key-1234';
async function makeChatSite(t, steps, { env = {}, chat = {}, ...rest } = {}) {
  const claude = fakeClaude(...steps);
  const site = await makeSite({ env: { ANTHROPIC_API_KEY: AI_KEY, ...env }, chat: { fetchImpl: claude.fetchImpl, ...chat }, ...rest });
  t.after(() => site.close());
  return { site, claude };
}

// What the browser sends: a chat that ends with the visitor's question. say(site, 'hi') or say(site, [{ role, content }, ...]).
const chatBody = (...texts) => ({ messages: texts.length === 1 && Array.isArray(texts[0]) ? texts[0] : texts.map((content) => ({ role: 'user', content })) });
const say = (site, ...texts) => site.app.locals.chat.reply(chatBody(...texts), { visitor: 'test-visitor' });

module.exports = {
  KEY_ID, KEY_SECRET, WEBHOOK_SECRET, START, MINUTE,
  fakeRazorpay, makeSite, sign, pay, bookAndPay, car, bike, AVAILABILITY_URL, webhookEvent, signedWebhook, basic,
  json, claudeMessage, claudeSays, claudeError, toolUse, fakeClaude, AI_KEY, makeChatSite, chatBody, say,
};
