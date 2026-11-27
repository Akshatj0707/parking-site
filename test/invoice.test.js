'use strict';

// The invoice of a finished booking: when it exists, how it is numbered, what the tax split is, and how a printed copy is checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSite, pay, car, MINUTE } = require('./helpers');
const { loadConfig } = require('../src/config');
const { createInvoices, eligibility, statement, splitTax, financialYear } = require('../src/invoice');
const jsQR = require('../public/js/vendor/jsQR.js');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const GSTIN = '23ABCDE1234F1Z5';
const HTML_ASK = { accept: 'text/html,application/xhtml+xml' };
const JSON_ASK = { accept: 'application/json' };
const SCAN = '/api/dashboard/gate/scan';

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });
const clockAt = (s, hh, mm) => {
  s.clock.t = Date.UTC(2026, 9, 14, hh, mm) - 330 * MINUTE; // lot time (UTC+5:30)
};

async function site(t, env = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, BUSINESS_NAME: 'Bayfind Parking', BUSINESS_ADDRESS: '12 MG Road, Indore', SUPPORT_EMAIL: 'help@bayfind.example', ...env } });
  t.after(() => s.close());
  return s;
}
async function adminCookie(s) {
  const r = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}
// Books and pays 11:00 to 13:00 on 14 Oct 2026. Returns { ref, pass, booking }.
async function paidBooking(s, over = {}, paymentId = 'pay_inv1', headers) {
  const created = await s.post('/api/bookings', car(over), headers ? { headers } : undefined);
  assert.equal(created.status, 201, created.text);
  const paid = await pay(s, created, paymentId);
  assert.equal(paid.status, 200, paid.text);
  const view = paid.json.booking;
  return { ref: view.ref, pass: new URL('http://x' + view.pass).searchParams.get('t'), booking: s.store.bookings.find((b) => b.ref === view.ref) };
}
// Drives the vehicle in at 10:50 and out at 12:30, the way the gate does.
async function visit(s, admin, made) {
  const tok = (kind) => s.app.locals.gate.tokenFor(kind, made.booking);
  clockAt(s, 10, 50);
  assert.equal((await s.post(SCAN, { token: tok('in') }, as(admin))).status, 200);
  clockAt(s, 12, 30);
  const out = await s.post(SCAN, { token: tok('out') }, as(admin));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.outcome, 'exited');
}
const invoicePage = (s, pass) => s.get('/invoice?t=' + encodeURIComponent(pass), { headers: HTML_ASK });
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

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

// ===== Settings ====================================================================================

test('a valid GST number makes tax invoices; a wrong one is ignored and the invoice stays a receipt', () => {
  const base = { DATA_DIR: '/tmp/x' };
  assert.deepEqual(loadConfig(base).invoice, { gstin: '', gstinIgnored: false, percent: 18, sac: '996743', prefix: 'INV' });
  assert.equal(loadConfig({ ...base, INVOICE_GSTIN: ` ${GSTIN.toLowerCase()} ` }).invoice.gstin, GSTIN, 'trimmed and upper-cased');
  const bad = loadConfig({ ...base, INVOICE_GSTIN: '23ABCDE1234F1' }).invoice;
  assert.equal(bad.gstin, '');
  assert.equal(bad.gstinIgnored, true);
  assert.equal(loadConfig({ ...base, INVOICE_GST_PERCENT: '250' }).invoice.percent, 28, 'never above the highest GST slab');
  assert.equal(loadConfig({ ...base, INVOICE_GST_PERCENT: '-3' }).invoice.percent, 18, 'a negative rate is nonsense, so the default is used');
  assert.equal(loadConfig({ ...base, INVOICE_GST_PERCENT: '0' }).invoice.percent, 0, 'zero is allowed (exempt)');
  assert.equal(loadConfig({ ...base, INVOICE_GST_PERCENT: 'abc' }).invoice.percent, 18);
  assert.equal(loadConfig({ ...base, INVOICE_SAC: '12' }).invoice.sac, '996743');
  assert.equal(loadConfig({ ...base, INVOICE_SAC: '999999' }).invoice.sac, '999999');
  assert.equal(loadConfig({ ...base, INVOICE_PREFIX: 'bf-2!x9yz' }).invoice.prefix, 'BF2X', 'letters and digits only, at most 4');
  assert.equal(loadConfig({ ...base, INVOICE_PREFIX: '---' }).invoice.prefix, 'INV');
});

// ===== The pure parts ==============================================================================

test('GST that is already inside the price is taken out in whole paise, and the three parts always add up', () => {
  assert.deepEqual(splitTax(8000, 18), { taxablePaise: 6780, cgstPaise: 610, sgstPaise: 610 });
  assert.deepEqual(splitTax(9999, 18), { taxablePaise: 8474, cgstPaise: 762, sgstPaise: 763 }, 'an odd paisa goes to SGST');
  assert.deepEqual(splitTax(8000, 0), { taxablePaise: 8000, cgstPaise: 0, sgstPaise: 0 });
  assert.deepEqual(splitTax(0, 18), { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 });
  for (let total = 1; total <= 3000; total++) {
    const x = splitTax(total, 18);
    assert.equal(x.taxablePaise + x.cgstPaise + x.sgstPaise, total, `total ${total}`);
    assert.ok(x.sgstPaise - x.cgstPaise === 0 || x.sgstPaise - x.cgstPaise === 1, `halves of ${total}`);
  }
});

test('the financial year runs April to March on the lot clock', () => {
  const lot = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - 330 * MINUTE;
  assert.deepEqual(financialYear(lot(2026, 10, 14, 11, 0), 330), { label: '2026-27', short: '2627' });
  assert.deepEqual(financialYear(lot(2027, 3, 31, 23, 59), 330), { label: '2026-27', short: '2627' });
  assert.deepEqual(financialYear(lot(2027, 4, 1, 0, 0), 330), { label: '2027-28', short: '2728' });
  assert.deepEqual(financialYear(lot(2026, 4, 1, 0, 0), 330), { label: '2026-27', short: '2627' });
  assert.deepEqual(financialYear(lot(2026, 3, 31, 23, 59), 330), { label: '2025-26', short: '2526' });
});

test('an invoice exists only when the money is settled: visit over, nothing to pay, any refund done', () => {
  const paid = { status: 'paid', amountPaise: 8000, startMs: 1000, endMs: 5000 };
  const ok = { ok: true };
  assert.deepEqual(eligibility(paid, 2000), { ok: false, reason: 'not_over' }, 'booked and waiting');
  assert.deepEqual(eligibility({ ...paid, entryAt: 1500 }, 9000), { ok: false, reason: 'not_over' }, 'still inside, even past the end');
  assert.deepEqual(eligibility({ ...paid, entryAt: 1500, exitAt: 4000 }, 4500), ok);
  assert.deepEqual(eligibility(paid, 5000), ok, 'never came, and the booked time is over');
  assert.deepEqual(eligibility({ ...paid, entryAt: 1500, exitScanAt: 6000, overstay: { status: 'due', amountPaise: 4000 } }, 7000), { ok: false, reason: 'charge_due' });
  assert.deepEqual(eligibility({ ...paid, entryAt: 1500, exitAt: 7000, overstay: { status: 'paid', amountPaise: 4000 } }, 7000), ok);
  assert.deepEqual(eligibility({ ...paid, status: 'refunded' }, 9000), { ok: false, reason: 'none' }, 'all of it came back');
  assert.deepEqual(eligibility({ ...paid, status: 'refunded', refundAmountPaise: 8000 }, 9000), { ok: false, reason: 'none' });
  assert.deepEqual(eligibility({ ...paid, status: 'refunded', refundAmountPaise: 4000 }, 9000), ok, 'half was kept');
  assert.deepEqual(eligibility({ ...paid, status: 'refund_pending' }, 9000), { ok: false, reason: 'refund_open' });
  assert.deepEqual(eligibility({ ...paid, status: 'refund_failed' }, 9000), { ok: false, reason: 'refund_open' });
  for (const status of ['pending', 'cancelled', 'expired', 'failed']) assert.equal(eligibility({ ...paid, status }, 9000).ok, false, status);
});

test('the money lines: the fee, hours added while parked, an extra charge that was paid, and a refund taken off', () => {
  const b = { status: 'paid', amountPaise: 8000, extensionPaise: 4000, overstay: { status: 'paid', amountPaise: 2000 } };
  const st = statement(b);
  assert.deepEqual(st.lines.map((l) => [l.key, l.paise]), [['booking', 8000], ['extension', 4000], ['overstay', 2000]]);
  assert.equal(st.totalPaise, 14000);
  assert.equal(statement({ status: 'paid', amountPaise: 8000, overstay: { status: 'waived', amountPaise: 2000 } }).totalPaise, 8000, 'a waived charge is not billed');
  const kept = statement({ status: 'refunded', amountPaise: 8000, refundAmountPaise: 4000 });
  assert.deepEqual(kept.lines.map((l) => [l.key, l.paise]), [['booking', 8000], ['refund', -4000]]);
  assert.equal(kept.totalPaise, 4000);
});

// ===== The invoice page ============================================================================

test('before the visit is over there is no invoice; after it there is one, and the pass and My bookings point to it', async (t) => {
  const s = await site(t, { CUSTOMER_LOGIN_REQUIRED: 'on' });
  const admin = await adminCookie(s);
  const signup = await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha.verma@example.com', password: 'a-good-password' });
  const customer = cookieOf(signup);
  const made = await paidBooking(s, {}, 'pay_inv1', { cookie: customer });

  const early = await invoicePage(s, made.pass);
  assert.equal(early.status, 409);
  assert.match(early.text, /No invoice yet/);
  assert.match(early.text, /ready when your parking is over/);
  assert.equal(made.booking.invoice, undefined, 'asking too early gives no number');
  assert.equal((await s.get('/api/pass?t=' + encodeURIComponent(made.pass))).json.invoice, null);
  assert.equal((await s.get('/api/account/bookings', as(customer))).json.bookings[0].invoice, undefined);

  await visit(s, admin, made);
  const passInfo = (await s.get('/api/pass?t=' + encodeURIComponent(made.pass))).json;
  assert.equal(passInfo.invoice, '/invoice?t=' + made.pass);
  const card = (await s.get('/api/account/bookings', as(customer))).json.bookings[0];
  assert.equal(card.invoice, '/invoice?t=' + made.pass);

  const page = await invoicePage(s, made.pass);
  assert.equal(page.status, 200, page.text);
  assert.doesNotMatch(page.text, /\{\{/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.text, /noindex/);
  const text = textOf(page.text);
  assert.match(text, /Receipt/);
  assert.doesNotMatch(text, /Tax invoice|CGST|SGST|GSTIN/, 'no GST number set: no GST is shown');
  assert.match(text, /not a tax invoice/);
  assert.match(text, /INV2627-00001/);
  assert.match(text, /Bayfind Parking/);
  assert.match(text, /12 MG Road, Indore/);
  assert.match(text, /Asha Verma/);
  assert.match(text, /MP 09 AB 1234/);
  assert.match(text, /Parking fee for the booked time/);
  assert.match(text, /₹ 80\.00/);
  assert.match(text, /Test copy/, 'test keys: no real money moved');
});

test('with a GST number it is a tax invoice with the tax split inside the price', async (t) => {
  const s = await site(t, { INVOICE_GSTIN: GSTIN });
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  const page = await invoicePage(s, made.pass);
  assert.equal(page.status, 200);
  const text = textOf(page.text);
  assert.match(text, /Tax invoice/);
  assert.match(text, new RegExp('GSTIN: ' + GSTIN));
  assert.match(text, /996743/);
  assert.match(text, /Taxable value 67\.80/);
  assert.match(text, /CGST @ 9% 6\.10/);
  assert.match(text, /SGST @ 9% 6\.10/);
  assert.match(text, /Total ₹ 80\.00/);
  assert.match(text, /state code 23/);
  assert.doesNotMatch(text, /not a tax invoice/);
});

test('numbers go one after the other, stay the same on every visit, and start again each April', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const a = await paidBooking(s, {}, 'pay_a');
  const b = await paidBooking(s, { plate: 'MP09CD5678', zone: 1 }, 'pay_b');
  await visit(s, admin, a);
  await visit(s, admin, b);

  const second = await invoicePage(s, b.pass); // opened first, so it gets the first number
  assert.match(second.text, /INV2627-00001/);
  const first = await invoicePage(s, a.pass);
  assert.match(first.text, /INV2627-00002/);
  const again = await invoicePage(s, b.pass);
  assert.match(again.text, /INV2627-00001/, 'the number never changes');
  assert.equal(b.booking.invoice.no, 'INV2627-00001');
  assert.equal(a.booking.invoice.seq, 2);

  // 1 April 2027: a new financial year, a new series.
  s.clock.t = Date.UTC(2027, 3, 1, 0, 30) - 330 * MINUTE;
  const c = await paidBooking(s, { date: '2027-04-02', plate: 'MP09EF9999' }, 'pay_c').catch(() => null);
  const inv = s.app.locals.invoices;
  if (c) {
    c.booking.exitAt = s.clock.t;
    c.booking.entryAt = s.clock.t - MINUTE;
    const made = await inv.issue(c.booking);
    assert.equal(made.no, 'INV2728-00001');
  }
  assert.equal(a.booking.invoice.no, 'INV2627-00002', 'old invoices keep their number');
});

test('the number is stored on the booking, so it survives a restart', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  const before = await invoicePage(s, made.pass);
  const saved = JSON.parse(JSON.stringify(s.store.bookings.find((x) => x.ref === made.ref)));
  assert.match(saved.invoice.no, /^INV2627-00001$/);
  assert.match(before.text, /INV2627-00001/);
  assert.equal(typeof saved.invoice.issuedAt, 'number');
});

test('a bad or borrowed link opens nothing', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const a = await paidBooking(s, {}, 'pay_a');
  await visit(s, admin, a);
  for (const bad of ['', 'garbage', 'pass.NOPE00.' + 'A'.repeat(22), a.pass.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))]) {
    const r = await s.get('/invoice?t=' + encodeURIComponent(bad), { headers: HTML_ASK });
    assert.equal(r.status, 404, bad);
    assert.match(r.text, /No invoice/);
  }
  // the entry or exit QR token is not the pass token
  const entry = s.app.locals.gate.tokenFor('in', a.booking);
  assert.equal((await invoicePage(s, entry)).status, 404);
  assert.equal(a.booking.invoice, undefined, 'nothing was numbered');
});

test('a late cancellation that kept part of the money gets an invoice for the part that was kept', async (t) => {
  const s = await site(t, { CUSTOMER_LOGIN_REQUIRED: 'on' });
  const signup = await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha.verma@example.com', password: 'a-good-password' });
  const cookie = cookieOf(signup);
  const made = await paidBooking(s, {}, 'pay_late', { cookie }); // paid at 10:00, starts at 11:00
  s.advance(15 * MINUTE); // the free period is over: half comes back
  const cancelled = await s.post(`/api/account/bookings/${made.ref}/cancel`, { acceptRefund: 40 }, as(cookie));
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(made.booking.status, 'refunded');

  const page = await invoicePage(s, made.pass);
  assert.equal(page.status, 200, page.text);
  const text = textOf(page.text);
  assert.match(text, /Parking booking, cancelled before use 80\.00/);
  assert.match(text, /Less: refunded to the customer -40\.00/);
  assert.match(text, /Total ₹ 40\.00/);
  assert.equal(made.booking.invoice.no, 'INV2627-00001');
});

test('a booking that was fully refunded, one that waits for its refund and one with an unpaid extra charge have no invoice', async (t) => {
  const s = await site(t);
  const a = await paidBooking(s, {}, 'pay_full');
  a.booking.status = 'refunded';
  a.booking.refundAmountPaise = a.booking.amountPaise;
  const full = await invoicePage(s, a.pass);
  assert.equal(full.status, 404);
  assert.match(full.text, /no invoice for this booking/);

  const b = await paidBooking(s, { plate: 'MP09CD5678', zone: 1 }, 'pay_wait');
  b.booking.status = 'refund_pending';
  const waiting = await invoicePage(s, b.pass);
  assert.equal(waiting.status, 409);
  assert.match(waiting.text, /refund is still being sent/);

  const c = await paidBooking(s, { plate: 'MP09EF4321', zone: 2 }, 'pay_due');
  c.booking.entryAt = s.clock.t;
  c.booking.exitScanAt = s.clock.t + MINUTE;
  c.booking.overstay = { hours: 1, amountPaise: 4000, status: 'due' };
  s.clock.t = c.booking.endMs + 60 * MINUTE;
  const due = await invoicePage(s, c.pass);
  assert.equal(due.status, 409);
  assert.match(due.text, /extra charge to pay/);
  for (const x of [a, b, c]) assert.equal(x.booking.invoice, undefined);
});

test('hours added while parked and a paid extra charge are on the invoice', async (t) => {
  const s = await site(t);
  const made = await paidBooking(s);
  made.booking.entryAt = made.booking.startMs;
  made.booking.exitAt = made.booking.endMs + 3600000;
  made.booking.extensionPaise = 4000;
  made.booking.overstay = { hours: 1, amountPaise: 4000, status: 'paid' };
  s.clock.t = made.booking.endMs + 2 * 3600000;
  const page = await invoicePage(s, made.pass);
  assert.equal(page.status, 200, page.text);
  const text = textOf(page.text);
  assert.match(text, /Extra hours added while parked 40\.00/);
  assert.match(text, /Extra time after the booked end 40\.00/);
  assert.match(text, /Total ₹ 160\.00/);
});

test('everything that comes from a booking or the settings is escaped', async (t) => {
  const s = await site(t, { BUSINESS_NAME: 'Bay <img src=x onerror=alert(1)> & Co', BUSINESS_ADDRESS: '"><script>alert(2)</script>' });
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  const page = await invoicePage(s, made.pass);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<img src=x|<script>alert/);
  assert.match(page.text, /Bay &lt;img src=x onerror=alert\(1\)&gt; &amp; Co/);
});

// ===== Checking a printed copy =====================================================================

test('the QR code on the invoice opens the check page, which says the invoice is genuine', async (t) => {
  const s = await site(t, { INVOICE_GSTIN: GSTIN });
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  const page = await invoicePage(s, made.pass);
  const svg = /<svg[\s\S]*?<\/svg>/.exec(page.text)[0];
  const url = readQr(svg);
  assert.ok(url, 'a phone could read the QR code');
  const parsed = new URL(url);
  assert.equal(parsed.origin, s.base);
  assert.equal(parsed.pathname, '/invoice/check');
  assert.equal(parsed.searchParams.get('n'), 'INV2627-00001');
  assert.match(parsed.searchParams.get('c'), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.match(page.text, new RegExp('Verification code ' + parsed.searchParams.get('c')));

  const check = await s.get(parsed.pathname + parsed.search, { headers: HTML_ASK });
  assert.equal(check.status, 200, check.text);
  assert.match(check.text, /This invoice is genuine/);
  const text = textOf(check.text);
  assert.match(text, /Tax invoice INV2627-00001/);
  assert.match(text, /MP 09 AB 1234/);
  assert.match(text, /₹80\.00/);
  assert.match(text, /test copy/i, 'a test invoice says so on the check page too');
  assert.equal(check.headers.get('cache-control'), 'no-store');
});

test('a wrong code, a wrong number or a changed amount is not a match', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  await invoicePage(s, made.pass);
  const inv = made.booking.invoice;
  const code = s.app.locals.invoices.verify(inv.no, '0000-0000-0000') ? 'x' : null;
  assert.equal(code, null, 'a made-up code is refused');
  const real = /Verification code ([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})/.exec((await invoicePage(s, made.pass)).text)[1];
  const ask = (n, c) => s.get(`/invoice/check?n=${encodeURIComponent(n)}&c=${encodeURIComponent(c)}`, { headers: HTML_ASK });

  assert.equal((await ask(inv.no, real)).status, 200);
  assert.equal((await ask(inv.no, real.toLowerCase().replace(/-/g, ''))).status, 200, 'case and dashes do not matter');
  for (const [n, c] of [[inv.no, '0000-0000-0000'], [inv.no, ''], [inv.no, real.slice(0, 9)], ['INV2627-00099', real], ['', real], ['<script>', real]]) {
    const r = await ask(n, c);
    assert.equal(r.status, 404, `${n} ${c}`);
    assert.match(r.text, /Not a match/);
    assert.doesNotMatch(r.text, /MP09/, 'a failed check shows nothing about any booking');
  }
  assert.equal((await s.get('/invoice/check', { headers: HTML_ASK })).status, 404);

  // someone changes the amount after the invoice was made: the old code no longer fits
  made.booking.amountPaise = 800;
  assert.equal((await ask(inv.no, real)).status, 404);
  made.booking.amountPaise = 8000;
  assert.equal((await ask(inv.no, real)).status, 200);
});

test('the code is tied to this website: another secret makes another code', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  await invoicePage(s, made.pass);
  const real = s.app.locals.invoices;
  const other = createInvoices({ config: s.config, bookings: s.bookings, signFor: (purpose, text) => Buffer.from(`${purpose}|${text}|other`).toString('base64url') + 'AAAAAAAAAAAAAAAA', userById: () => null, now: () => s.clock.t });
  const inv = made.booking.invoice;
  const code = /Verification code ([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})/.exec((await invoicePage(s, made.pass)).text)[1];
  assert.ok(real.verify(inv.no, code));
  assert.equal(other.verify(inv.no, code), null);
});

test('with live Razorpay payments the invoice is not marked as a test copy; a simulated payment always is', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const made = await paidBooking(s);
  await visit(s, admin, made);
  const live = createInvoices({ config: { ...s.config, razorpay: { ...s.config.razorpay, live: true } }, bookings: s.bookings, signFor: s.app.locals.auth.signFor, userById: () => null, now: () => s.clock.t });
  assert.equal((await live.issue(made.booking)).test, false);
  assert.match(live.html(await live.issue(made.booking), '<svg></svg>', 'https://x.example/invoice/check'), /^(?!.*Test copy)/s);
  made.booking.mode = 'demo';
  assert.equal((await live.issue(made.booking)).test, true, 'a simulated payment moved no money');
});

test('the invoice routes are rate limited', async (t) => {
  const s = await site(t);
  let blocked = 0;
  for (let i = 0; i < 40; i++) {
    const r = await s.get('/invoice/check?n=x&c=y', { headers: HTML_ASK });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked > 0, 'more than 30 a minute from one address is refused');
});
