'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../public/js/shared.js');
const { loadConfig } = require('../src/config');
const { hmacHex, safeEqual, verifyPaymentSignature, verifyWebhookSignature } = require('../src/payments');
const { Store } = require('../src/store');
const { HitCounter } = require('../src/ratelimit');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-unit-'));

// ---- Vehicle numbers -----------------------------------------------------------------------------

test('vehicle numbers are tidied up before they are checked', () => {
  assert.equal(S.normalizePlate(' mp-09 ab  1234 '), 'MP09AB1234');
  assert.equal(S.normalizePlate('mp09ab1234'), 'MP09AB1234');
  assert.equal(S.normalizePlate(null), '');
  assert.equal(S.normalizePlate(undefined), '');
  assert.equal(S.normalizePlate('x'.repeat(100)).length, 40);
});

test('Indian vehicle number formats are accepted and nonsense is not', () => {
  for (const ok of ['MP09AB1234', 'KA011234', 'DL1CAB1234', 'MH12DE1433', 'TN07AAB0001', 'GJ05A1234']) {
    assert.equal(S.isValidPlate(ok), true, ok);
  }
  for (const bad of ['', 'HELLO', 'MP09AB123', 'MP09AB12345', 'M09AB1234', 'MP09ABCD1234', '1234MP09AB', 'MP-09-AB-1234', 'UP3299', '12AB3456']) {
    assert.equal(S.isValidPlate(bad), false, bad);
  }
});

test('vehicle numbers are shown with spaces', () => {
  assert.equal(S.formatPlate('MP09AB1234'), 'MP 09 AB 1234');
  assert.equal(S.formatPlate('KA011234'), 'KA 01 1234');
  assert.equal(S.formatPlate('DL1CAB1234'), 'DL 1 CAB 1234');
  assert.equal(S.formatPlate('not a plate'), 'not a plate');
});

// ---- The lot --------------------------------------------------------------------------------------

test('the lot has 200 four-wheeler and 250 two-wheeler bays', () => {
  assert.equal(S.LOT.car.total, 200);
  assert.equal(S.LOT.bike.total, 250);
  for (const v of S.VEHICLES) assert.equal(S.LOT[v].total, S.LOT[v].perZone * S.LOT[v].zones.length, `${v}: total must equal perZone x zones`);
});

test('bay ids round-trip and out-of-range bays are rejected', () => {
  assert.equal(S.bayId('car', 7), 'C007');
  assert.equal(S.bayId('car', 200), 'C200');
  assert.equal(S.bayId('bike', 250), 'B250');
  assert.deepEqual(S.parseBay('C001'), { vehicle: 'car', n: 1, zone: 0 });
  assert.deepEqual(S.parseBay('C050'), { vehicle: 'car', n: 50, zone: 0 });
  assert.deepEqual(S.parseBay('C051'), { vehicle: 'car', n: 51, zone: 1 });
  assert.deepEqual(S.parseBay('C200'), { vehicle: 'car', n: 200, zone: 3 });
  assert.deepEqual(S.parseBay('B250'), { vehicle: 'bike', n: 250, zone: 4 });
  for (const bad of ['C000', 'C201', 'B251', 'X001', 'c001', 'C01', 'C0001', '', null, undefined, 'C 001']) {
    assert.equal(S.parseBay(bad), null, String(bad));
  }
});

// ---- Lot time ----------------------------------------------------------------------------------------

test('dates and times are read on the lot clock (India, UTC+05:30)', () => {
  assert.equal(S.startMsFromLot('2026-10-14', '10:00', 330), Date.UTC(2026, 9, 14, 4, 30));
  assert.equal(S.startMsFromLot('2026-10-17', '00:00', 330), Date.UTC(2026, 9, 16, 18, 30));
  assert.ok(Number.isNaN(S.startMsFromLot('14/10/2026', '10:00', 330)));
  assert.ok(Number.isNaN(S.startMsFromLot('2026-10-14', '10am', 330)));
  assert.ok(Number.isNaN(S.startMsFromLot(undefined, undefined, 330)));
  // Saturday 00:00 in India is still Friday evening in UTC.
  const satMidnight = Date.UTC(2026, 9, 16, 18, 30);
  assert.equal(S.lotDateString(satMidnight, 330), '2026-10-17');
  assert.equal(S.lotParts(satMidnight, 330).dow, 6);
  assert.equal(new Date(satMidnight).getUTCDay(), 5);
});

test('start times snap to half hours', () => {
  const t = Date.UTC(2026, 9, 14, 4, 47); // 10:17 in India
  assert.equal(S.slotFloor(t, 330, 30), Date.UTC(2026, 9, 14, 4, 30));
  assert.equal(S.slotFloor(Date.UTC(2026, 9, 14, 4, 30), 330, 30), Date.UTC(2026, 9, 14, 4, 30));
});

test('times and windows read naturally, including across midnight', () => {
  assert.equal(S.formatTime(S.startMsFromLot('2026-10-14', '00:00', 330), 330), '12:00 am');
  assert.equal(S.formatTime(S.startMsFromLot('2026-10-14', '00:30', 330), 330), '12:30 am');
  assert.equal(S.formatTime(S.startMsFromLot('2026-10-14', '12:00', 330), 330), '12:00 pm');
  assert.equal(S.formatTime(S.startMsFromLot('2026-10-14', '17:30', 330), 330), '5:30 pm');
  const a = S.startMsFromLot('2026-10-14', '11:00', 330);
  assert.equal(S.formatWindow(a, a + 2 * S.HOUR, 330), 'Wed 14 Oct, 11:00 am – 1:00 pm');
  const b = S.startMsFromLot('2026-10-16', '23:30', 330);
  assert.equal(S.formatWindow(b, b + 2 * S.HOUR, 330), 'Fri 16 Oct, 11:30 pm – Sat 17 Oct, 1:30 am');
});

// ---- Pricing -----------------------------------------------------------------------------------------

test('price depends on the vehicle, the day the booking starts, and the hours', () => {
  const cfg = loadConfig({});
  const at = (date, time) => S.startMsFromLot(date, time, 330);
  assert.deepEqual(S.priceFor('car', at('2026-10-14', '11:00'), 2, cfg), { dayType: 'weekday', rate: 40, rupees: 80, paise: 8000 });
  assert.deepEqual(S.priceFor('car', at('2026-10-17', '11:00'), 2, cfg), { dayType: 'weekend', rate: 60, rupees: 120, paise: 12000 });
  assert.deepEqual(S.priceFor('bike', at('2026-10-14', '11:00'), 3, cfg), { dayType: 'weekday', rate: 20, rupees: 60, paise: 6000 });
  assert.deepEqual(S.priceFor('bike', at('2026-10-18', '11:00'), 4, cfg), { dayType: 'weekend', rate: 30, rupees: 120, paise: 12000 });
  // A booking that starts on Friday night keeps Friday's rate even though it runs into Saturday.
  assert.equal(S.priceFor('car', at('2026-10-16', '23:30'), 2, cfg).dayType, 'weekday');
  assert.equal(S.priceFor('car', at('2026-10-17', '00:00'), 1, cfg).dayType, 'weekend');
});

test('custom weekend days and rates are respected', () => {
  const cfg = loadConfig({ WEEKEND_DAYS: '5,6', RATE_CAR_WEEKDAY: '50', RATE_CAR_WEEKEND: '75.5' });
  const friday = S.startMsFromLot('2026-10-16', '10:00', 330);
  const sunday = S.startMsFromLot('2026-10-18', '10:00', 330);
  assert.equal(S.priceFor('car', friday, 2, cfg).rupees, 151);
  assert.equal(S.priceFor('car', friday, 2, cfg).paise, 15100);
  assert.equal(S.priceFor('car', sunday, 2, cfg).rupees, 100);
});

// ---- Settings -----------------------------------------------------------------------------------------

test('default settings', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.production, false);
  assert.equal(c.siteName, 'Bayfind');
  assert.deepEqual(c.rates, { car: { weekday: 40, weekend: 60 }, bike: { weekday: 20, weekend: 30 } });
  assert.deepEqual(c.weekendDays, [0, 6]);
  assert.equal(c.utcOffsetMinutes, 330);
  assert.equal(c.holdMinutes, 10);
  assert.equal(c.razorpay.configured, false);
  assert.equal(c.razorpay.live, false);
  assert.equal(c.disableCsp, false);
  assert.equal(c.demoSettingIgnored, false);
  assert.equal(c.unsafeLiveStorage, false);
  assert.equal(c.operator.password, '');
});

test('DEMO_PAYMENTS is gone: it is ignored (and noticed), and never makes anything pretend', () => {
  for (const yes of ['1', 'true', 'on', ' On ']) {
    const c = loadConfig({ NODE_ENV: 'production', RENDER: 'true', DEMO_PAYMENTS: yes });
    assert.equal(c.demoSettingIgnored, true, JSON.stringify(yes));
    assert.equal(c.demoPayments, undefined, 'there is no such setting any more');
    assert.equal(c.razorpay.configured, false, 'it does not pretend that Razorpay is set up');
  }
  for (const no of [undefined, '', '0', 'off']) assert.equal(loadConfig({ DEMO_PAYMENTS: no }).demoSettingIgnored, false, JSON.stringify(no));
});

test('live keys on storage that is wiped at every restart are flagged, test keys and a real disk are not', () => {
  const live = { RENDER: 'true', NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's' };
  assert.equal(loadConfig({ ...live, DATA_DIR: '/tmp/somewhere' }).unsafeLiveStorage, true);
  assert.equal(loadConfig({ ...live }).unsafeLiveStorage, false, 'the default folder on Render is on the disk');
  assert.equal(loadConfig({ ...live, DATA_DIR: '/var/data/live' }).unsafeLiveStorage, false);
  assert.equal(loadConfig({ ...live, RAZORPAY_KEY_ID: 'rzp_test_x', DATA_DIR: '/tmp/somewhere' }).unsafeLiveStorage, false);
  assert.equal(loadConfig({ ...live, RENDER: '', DATA_DIR: '/tmp/somewhere' }).unsafeLiveStorage, false, 'nothing is known about other hosts');
});

test('the test customer is only made when SEED_TEST_CUSTOMER is switched on, and never with Razorpay keys', () => {
  assert.equal(loadConfig({ NODE_ENV: 'production' }).auth.seedTestCustomer, false);
  assert.equal(loadConfig({ SEED_TEST_CUSTOMER: 'on' }).auth.seedTestCustomer, true);
  assert.equal(loadConfig({ SEED_TEST_CUSTOMER: 'on', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' }).auth.seedTestCustomer, false);
});

test('settings come from the environment and bad values fall back', () => {
  const c = loadConfig({
    NODE_ENV: 'production', PORT: '8080', RATE_CAR_WEEKDAY: '55', RATE_CAR_WEEKEND: 'abc', RATE_BIKE_WEEKDAY: '-3',
    WEEKEND_DAYS: '5, 6', HOLD_MINUTES: '0', SITE_NAME: '  Park & Go  ', RAZORPAY_KEY_ID: ' rzp_live_x ', RAZORPAY_KEY_SECRET: 'sec',
    TRUST_PROXY: '1', DISABLE_CSP: 'yes',
  });
  assert.equal(c.production, true);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 8080);
  assert.equal(c.rates.car.weekday, 55);
  assert.equal(c.rates.car.weekend, 60);
  assert.equal(c.rates.bike.weekday, 20);
  assert.deepEqual(c.weekendDays, [5, 6]);
  assert.equal(c.holdMinutes, 10);
  assert.equal(c.siteName, 'Park & Go');
  assert.equal(c.razorpay.keyId, 'rzp_live_x');
  assert.equal(c.razorpay.configured, true);
  assert.equal(c.razorpay.live, true);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.disableCsp, true);
});

test('a key id without a secret is not enough to turn on Razorpay', () => {
  assert.equal(loadConfig({ RAZORPAY_KEY_ID: 'rzp_test_x' }).razorpay.configured, false);
  assert.equal(loadConfig({ RAZORPAY_KEY_SECRET: 'sec' }).razorpay.configured, false);
  assert.equal(loadConfig({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'sec' }).razorpay.live, false);
});

test('weekend days that make no sense fall back to Saturday and Sunday', () => {
  assert.deepEqual(loadConfig({ WEEKEND_DAYS: 'x,9,-1' }).weekendDays, [0, 6]);
  assert.deepEqual(loadConfig({ WEEKEND_DAYS: '' }).weekendDays, [0, 6]);
  assert.deepEqual(loadConfig({ WEEKEND_DAYS: '6' }).weekendDays, [6]);
});

// ---- Signatures -----------------------------------------------------------------------------------------

test('HMAC-SHA256 matches the published test vector', () => {
  assert.equal(
    hmacHex('key', 'The quick brown fox jumps over the lazy dog'),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
  );
});

test('payment signatures: only the right order, payment and secret pass', () => {
  const sig = hmacHex('secret', 'order_1|pay_1');
  assert.equal(verifyPaymentSignature('secret', 'order_1', 'pay_1', sig), true);
  assert.equal(verifyPaymentSignature('secret', 'order_1', 'pay_2', sig), false);
  assert.equal(verifyPaymentSignature('secret', 'order_2', 'pay_1', sig), false);
  assert.equal(verifyPaymentSignature('other', 'order_1', 'pay_1', sig), false);
  assert.equal(verifyPaymentSignature('secret', 'order_1', 'pay_1', 'abc'), false);
  assert.equal(verifyPaymentSignature('secret', 'order_1', 'pay_1', undefined), false);
  assert.equal(verifyPaymentSignature('secret', 'order_1', 'pay_1', sig.toUpperCase()), false);
});

test('webhook signatures cover the exact raw body', () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  const sig = hmacHex('whsec', body);
  assert.equal(verifyWebhookSignature('whsec', body, sig), true);
  assert.equal(verifyWebhookSignature('whsec', Buffer.from('{"event":"payment.captured" }'), sig), false);
  assert.equal(verifyWebhookSignature('wrong', body, sig), false);
  assert.equal(verifyWebhookSignature('whsec', body, ''), false);
  assert.equal(verifyWebhookSignature('whsec', body, undefined), false);
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);
});

// ---- Saving bookings ------------------------------------------------------------------------------------

test('bookings survive a restart', () => {
  const dir = tempDir();
  const s = new Store(dir);
  s.add({ id: 'bk_1', status: 'paid', createdAt: 1 });
  s.save();
  assert.deepEqual(new Store(dir).bookings, [{ id: 'bk_1', status: 'paid', createdAt: 1 }]);
  assert.equal(fs.existsSync(path.join(dir, 'bookings.json.tmp')), false, 'no leftover temp file');
});

test('a damaged bookings file is set aside and the site still starts', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bookings.json'), '{ this is not json');
  const original = console.error;
  const messages = [];
  console.error = (m) => messages.push(m);
  let s;
  try {
    s = new Store(dir);
  } finally {
    console.error = original;
  }
  assert.deepEqual(s.bookings, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('bookings.json.corrupt-')), 'the damaged file is kept');
  assert.equal(messages.length, 1);
});

test('old unpaid holds and cancelled bookings are cleaned up, paid and refunded ones are kept', () => {
  const dir = tempDir();
  const s = new Store(dir);
  const now = Date.now();
  const hour = 3600 * 1000;
  s.add({ id: 'old-pending', status: 'pending', createdAt: now - 25 * hour });
  s.add({ id: 'old-cancelled', status: 'cancelled', createdAt: now - 25 * hour });
  s.add({ id: 'old-paid', status: 'paid', createdAt: now - 25 * hour });
  s.add({ id: 'new-pending', status: 'pending', createdAt: now - hour });
  s.add({ id: 'old-refunded', status: 'refunded', createdAt: now - 48 * hour });
  s.purge(now);
  assert.deepEqual(s.bookings.map((b) => b.id).sort(), ['new-pending', 'old-paid', 'old-refunded']);
  assert.deepEqual(new Store(dir).bookings.map((b) => b.id).sort(), ['new-pending', 'old-paid', 'old-refunded']);
});

test('lookups by order id and booking id', () => {
  const s = new Store(tempDir());
  s.add({ id: 'bk_1', orderId: 'order_1' });
  s.add({ id: 'bk_2', orderId: null });
  assert.equal(s.get('bk_1').orderId, 'order_1');
  assert.equal(s.byOrderId('order_1').id, 'bk_1');
  assert.equal(s.byOrderId('order_x'), null);
  assert.equal(s.get('nope'), null);
  s.remove('bk_1');
  assert.equal(s.get('bk_1'), null);
});

// ---- Rate limiting ---------------------------------------------------------------------------------------

test('the hit counter counts inside a window and forgets afterwards', () => {
  let t = 1000;
  const counter = new HitCounter(60000, () => t);
  assert.equal(counter.hit('a').count, 1);
  assert.equal(counter.hit('a').count, 2);
  assert.equal(counter.hit('b').count, 1);
  assert.equal(counter.current('a').count, 2);
  t += 59999;
  assert.equal(counter.current('a').count, 2);
  t += 2;
  assert.equal(counter.current('a'), null);
  assert.equal(counter.hit('a').count, 1, 'a new window starts at one');
  counter.sweep();
  assert.equal(counter.entries.has('b'), false, 'expired entries are swept away');
});
