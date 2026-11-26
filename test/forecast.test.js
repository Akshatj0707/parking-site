'use strict';

// The demand forecast: how a day is guessed, how the guess is checked against the past, and the price ideas that come from it.
// Most tests build a lot that repeats the same week again and again, so the right answer is known before the code runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeSite, pay, car, MINUTE } = require('./helpers');
const { loadConfig } = require('../src/config');
const { forecast, predict, dayTable, confidenceOf, SERIES, MIN_HISTORY } = require('../src/forecast');
const S = require('../public/js/shared.js');

const OFF = 330;
const DAY_MS = 24 * 60 * MINUTE;
const config = loadConfig({ DATA_DIR: '/tmp/forecast-test' });
const NOW = Date.UTC(2026, 9, 14, 4, 30); // Wed 14 Oct 2026, 10:00 lot time
const TODAY = '2026-10-14';
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
const dow = (date) => new Date(Date.parse(date + 'T00:00:00Z')).getUTCDay();

let counter = 0;
// One paid booking on a lot date from `hh`:00 for `hours` hours.
function booking(date, hh = 10, hours = 2, vehicle = 'car', over = {}) {
  const startMs = S.startMsFromLot(date, String(hh).padStart(2, '0') + ':00', OFF);
  return { id: 'bk_' + ++counter, ref: 'R' + counter, status: 'paid', vehicle, startMs, endMs: startMs + hours * 60 * MINUTE, amountPaise: 8000, paidAt: startMs - 60 * MINUTE, ...over };
}
const many = (n, ...args) => Array.from({ length: n }, () => booking(...args));

// 35 finished days (9 Sep to 13 Oct) that repeat one week: 170 cars on a Saturday, 48 cars on any other day, 10:00 to 12:00.
function steadyLot(first = '2026-09-09', last = '2026-10-13', saturday = 170, other = 48) {
  const out = [];
  for (let d = first; d <= last; d = shift(d, 1)) out.push(...many(dow(d) === 6 ? saturday : other, d, 10, 2, 'car'));
  return out;
}
const run = (bookings, cfg = config, now = NOW) => forecast(bookings, { now, config: cfg });
const saturday = (f) => f.days.find((d) => d.date === '2026-10-17');

// ===== Is there enough to go on =====================================================================

test('with fewer than 7 days of bookings there is no forecast, and the reason says how many days there are', () => {
  const empty = run([]);
  assert.equal(empty.ready, false);
  assert.equal(empty.confidence, 'low');
  assert.deepEqual(empty.days, []);
  assert.deepEqual(empty.suggestions, []);
  assert.match(empty.reason, /at least 7 days/);
  assert.match(empty.reason, /0 days/);

  const three = run(steadyLot('2026-10-11', '2026-10-13'));
  assert.equal(three.ready, false);
  assert.equal(three.history.days, 3);
  assert.match(three.reason, /3 days/);

  const seven = run(steadyLot('2026-10-07', '2026-10-13'));
  assert.equal(seven.history.days, MIN_HISTORY);
  assert.equal(seven.ready, true, 'exactly 7 days is enough');
  assert.equal(seven.confidence, 'low', 'but not enough to trust');
});

test('only paid bookings count: refunded, cancelled, expired and unpaid ones are ignored', () => {
  const real = steadyLot();
  const noise = [];
  for (const status of ['refunded', 'cancelled', 'pending', 'expired', 'refund_pending']) noise.push(...many(30, '2026-10-12', 10, 2, 'car', { status }));
  const a = run(real);
  const b = run([...real, ...noise]);
  assert.deepEqual(b.days, a.days);
  assert.deepEqual(b.accuracy, a.accuracy);
});

// ===== The method ===================================================================================

test('a lot that repeats the same week is forecast exactly, and the error measure is zero', () => {
  const f = run(steadyLot());
  assert.equal(f.ready, true);
  assert.equal(f.history.days, 35);
  assert.equal(f.history.from, '2026-09-09');
  assert.equal(f.days.length, 7);
  assert.deepEqual(f.days.map((d) => d.date), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);

  const sat = saturday(f);
  assert.equal(sat.label, 'Sat 17 Oct');
  assert.equal(sat.dayType, 'weekend');
  assert.equal(sat.method, 'same-weekday');
  assert.equal(sat.arrivals.expected, 170);
  assert.equal(sat.arrivals.bookedSoFar, 0);
  assert.equal(sat.bayHours.expected, 340);
  assert.equal(sat.car.peakPercent, 85, '170 of 200 four-wheeler bays');
  assert.deepEqual(sat.car.peakHour, { hour: 10, label: '10 am – 11 am' });
  assert.equal(sat.bike.peakPercent, 0);
  assert.equal(sat.bike.peakHour, null);
  const wed = f.days[0];
  assert.equal(wed.dayType, 'weekday');
  assert.equal(wed.arrivals.expected, 48);
  assert.equal(wed.car.peakPercent, 24);

  assert.equal(f.accuracy.days, 14);
  for (const name of Object.keys(SERIES)) assert.deepEqual({ mae: f.accuracy.series[name].mae, bias: f.accuracy.series[name].bias }, { mae: 0, bias: 0 }, name);
  assert.equal(f.accuracy.series.arrivals.wape, 0);
  assert.equal(f.accuracy.series.bayHours.wape, 0);
  assert.equal(f.confidence, 'high');
});

test('the same weekday of last week counts 4, the week before 3, then 2 and 1', () => {
  // Wed 14 Oct is the target; its Wednesdays: 7 Oct (10 bookings), 30 Sep (20), 23 Sep (30), 16 Sep (40). Other days are empty but exist.
  const list = [...many(10, '2026-10-07'), ...many(20, '2026-09-30'), ...many(30, '2026-09-23'), ...many(40, '2026-09-16'), ...many(1, '2026-09-09')];
  const table = dayTable(list, OFF);
  const p = predict(table, SERIES.arrivals, '2026-10-14', '2026-10-14');
  assert.equal(p.method, 'same-weekday');
  assert.equal(p.value, (4 * 10 + 3 * 20 + 2 * 30 + 1 * 40) / 10);
  // only two weeks of the same weekday exist: still the weekday method, with just those two
  const two = dayTable([...many(10, '2026-10-07'), ...many(30, '2026-09-30'), ...many(1, '2026-09-29')], OFF);
  assert.equal(predict(two, SERIES.arrivals, '2026-10-14', '2026-10-14').value, (4 * 10 + 3 * 30) / 7);
});

test('with fewer than two of the same weekday it falls back to the average of the last 7 days', () => {
  // 9 days of history (5 to 13 Oct): a target has at most one same weekday behind it
  const list = [];
  for (let d = '2026-10-05'; d <= '2026-10-13'; d = shift(d, 1)) list.push(...many(d === '2026-10-13' ? 14 : 7, d));
  const table = dayTable(list, OFF);
  const p = predict(table, SERIES.arrivals, '2026-10-17', '2026-10-14');
  assert.equal(p.method, 'recent-average');
  assert.equal(p.value, (14 + 6 * 7) / 7, 'the last seven days: one of 14 and six of 7');
  assert.equal(run(list).days[3].method, 'recent-average');
});

test('a day is never forecast below what is already paid for', () => {
  const f0 = run(steadyLot());
  assert.equal(f0.days[1].arrivals.expected, 48);
  const booked = [...steadyLot(), ...many(70, '2026-10-15', 10, 2, 'car')]; // Thu 15 Oct already has 70 paid bookings
  const f = run(booked);
  const thu = f.days[1];
  assert.equal(thu.arrivals.bookedSoFar, 70);
  assert.equal(thu.arrivals.expected, 70);
  assert.equal(thu.arrivals.floored, true);
  assert.equal(thu.car.peakPercent, 35, '70 of 200 bays are already booked in one hour');
  assert.equal(thu.car.bookedPercent, 35);
  assert.equal(f.days[0].arrivals.floored, false);
  // the days that are booked in advance are not part of the history, so they do not change the error measure
  assert.deepEqual(f.accuracy, f0.accuracy);
});

test('a booking that runs past midnight is split between the two days', () => {
  const table = dayTable([booking('2026-10-12', 22, 4, 'bike')], OFF); // 10 pm to 2 am
  const mon = table.days.get('2026-10-12');
  const tue = table.days.get('2026-10-13');
  assert.equal(mon.arrivals, 1);
  assert.equal(tue.arrivals, 0);
  assert.equal(mon.hours.bike[22] + mon.hours.bike[23], 2);
  assert.equal(tue.hours.bike[0] + tue.hours.bike[1], 2);
});

// ===== How far off it is ============================================================================

test('the error measure: a hand-worked example (MAE and WAPE), checked against a plain "same as last week" guess', () => {
  // 10 bookings every day for 30 days (14 Sep to 13 Oct), except yesterday, which had 20.
  const list = [];
  for (let d = '2026-09-14'; d <= '2026-10-13'; d = shift(d, 1)) list.push(...many(d === '2026-10-13' ? 20 : 10, d));
  const f = run(list);
  const a = f.accuracy.series.arrivals;
  assert.equal(f.accuracy.days, 14);
  // 13 days forecast exactly; yesterday forecast 10 against 20: miss 10 out of a real total of 13 x 10 + 20 = 150
  assert.equal(a.mae, 0.7);
  assert.equal(a.wape, 0.067);
  assert.equal(a.bias, -0.7, 'the forecast was too low on average');
  assert.equal(a.naiveWape, 0.067, 'last week was also 10');
  // the unusual day does not leak into the forecast of the day itself
  const table = dayTable(list, OFF);
  assert.equal(predict(table, SERIES.arrivals, '2026-10-13', '2026-10-13').value, 10);
  // but the day after is pulled up a little, by one of its four same weekdays (weight 4 of 10)
  assert.equal(predict(table, SERIES.arrivals, '2026-10-20', '2026-10-14').value, (4 * 20 + 3 * 10 + 2 * 10 + 1 * 10) / 10);
});

test('the method beats "same as last week" when last week was the odd one out', () => {
  // every Wednesday has 20 bookings, except 30 Sep which had 60; all other days have 5. On 7 Oct, "last week" is the odd one out.
  const list = [];
  for (let d = '2026-09-09'; d <= '2026-10-13'; d = shift(d, 1)) list.push(...many(dow(d) === 3 ? (d === '2026-09-30' ? 60 : 20) : 5, d));
  const f = run(list);
  const a = f.accuracy.series.arrivals;
  assert.ok(a.wape < a.naiveWape, `${a.wape} should be below ${a.naiveWape}`);
});

test('confidence needs history, a back-test and a small enough miss', () => {
  const acc = (days, wape) => ({ days, series: { bayHours: { wape } } });
  assert.equal(confidenceOf(40, acc(14, 0.1)), 'high');
  assert.equal(confidenceOf(20, acc(14, 0.1)), 'medium', 'under 28 days of history never reaches high');
  assert.equal(confidenceOf(40, acc(14, 0.3)), 'medium');
  assert.equal(confidenceOf(40, acc(14, 0.5)), 'low', 'off by half is not to be trusted');
  assert.equal(confidenceOf(10, acc(14, 0.1)), 'low');
  assert.equal(confidenceOf(40, acc(3, 0.1)), 'low');
  assert.equal(confidenceOf(40, acc(14, null)), 'low');
});

// ===== Price ideas ==================================================================================

test('a day that is expected to be nearly full gets a higher-rate idea; the quiet-looking others get nothing', () => {
  const f = run(steadyLot());
  const cars = f.suggestions.filter((s) => s.vehicle === 'car');
  assert.equal(cars.length, 1, JSON.stringify(cars));
  assert.equal(cars[0].date, '2026-10-17');
  assert.equal(cars[0].action, 'raise');
  assert.equal(cars[0].from, 60, 'the weekend rate');
  assert.equal(cars[0].to, 66, '10 percent more');
  assert.match(cars[0].text, /Sat 17 Oct/);
  assert.match(cars[0].text, /85% full/);
  assert.match(cars[0].text, /10 am – 11 am/);
  assert.match(cars[0].text, /₹66 an hour instead of ₹60/);
  assert.equal(saturday(f).car.suggestion.action, 'raise');
  assert.equal(f.days[0].car.suggestion.action, 'keep');
  // two-wheelers had no bookings at all: no per-day idea, but a note that the whole week is quiet
  assert.equal(f.suggestions.filter((s) => s.vehicle === 'bike').length, 0);
  assert.ok(f.notes.some((n) => /2-wheeler bays are expected to stay under 25% full/.test(n)), JSON.stringify(f.notes));
});

test('a quiet day in a busy week gets an offer idea, at most one step lower', () => {
  // Weekdays 90 cars (45%), Sunday only 20 cars (10%), Saturday 150 (75%): Sunday is quiet next to the week
  const list = [];
  for (let d = '2026-09-09'; d <= '2026-10-13'; d = shift(d, 1)) list.push(...many(dow(d) === 0 ? 20 : dow(d) === 6 ? 150 : 90, d));
  const f = run(list);
  const offers = f.suggestions.filter((s) => s.action === 'lower');
  assert.equal(offers.length, 1, JSON.stringify(f.suggestions));
  assert.equal(offers[0].date, '2026-10-18');
  assert.equal(offers[0].from, 60);
  assert.equal(offers[0].to, 54);
  assert.match(offers[0].text, /quiet day/);
  assert.equal(f.suggestions.filter((s) => s.action === 'raise').length, 0, 'nothing reaches 80 percent');
});

test('the thresholds and the step come from the settings', () => {
  const strict = loadConfig({ DATA_DIR: '/tmp/forecast-test', FORECAST_HIGH_PERCENT: '90', FORECAST_STEP_PERCENT: '25' });
  assert.equal(run(steadyLot(), strict).suggestions.filter((s) => s.action === 'raise').length, 0, '85 percent is under a 90 percent limit');
  const keen = loadConfig({ DATA_DIR: '/tmp/forecast-test', FORECAST_HIGH_PERCENT: '70', FORECAST_STEP_PERCENT: '25' });
  const s = run(steadyLot(), keen).suggestions.find((x) => x.action === 'raise');
  assert.equal(s.to, 75, '60 plus 25 percent');
  assert.deepEqual(loadConfig({ DATA_DIR: '/tmp/x' }).forecast, { highPercent: 80, lowPercent: 25, stepPercent: 10 });
  const odd = loadConfig({ DATA_DIR: '/tmp/x', FORECAST_HIGH_PERCENT: '10', FORECAST_LOW_PERCENT: '99', FORECAST_STEP_PERCENT: '900' }).forecast;
  assert.deepEqual(odd, { highPercent: 50, lowPercent: 40, stepPercent: 50 }, 'kept in sensible bounds, and the low limit stays well under the high one');
});

test('with low confidence there are no price ideas, and the page is told why', () => {
  const f = run(steadyLot('2026-10-04', '2026-10-13')); // 10 days
  assert.equal(f.ready, true);
  assert.equal(f.confidence, 'low');
  assert.deepEqual(f.suggestions, []);
  assert.ok(f.notes.some((n) => /not reliable enough yet/.test(n)));
  assert.ok(f.days.every((d) => d.car.suggestion.action === 'keep' && d.bike.suggestion.action === 'keep'));
});

test('a forecast never changes a price or a booking', () => {
  const list = steadyLot();
  const before = JSON.stringify({ list, rates: config.rates, forecast: config.forecast });
  run(list);
  run(list);
  assert.equal(JSON.stringify({ list, rates: config.rates, forecast: config.forecast }), before);
  assert.deepEqual(config.rates.car, { weekday: 40, weekend: 60 });
});

// ===== On the website ===============================================================================

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};

test('the forecast route is for the people who may see the analytics, and only reads', async (t) => {
  const s = await makeSite({ razorpayKeys: true, env: { OPERATOR_PASSWORD: 'correct horse battery' } });
  t.after(() => s.close());
  assert.equal((await s.get('/api/dashboard/forecast', { headers: { accept: 'application/json' } })).status, 401);

  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: 'correct horse battery' }));
  const empty = await s.get('/api/dashboard/forecast', { headers: { cookie: admin, accept: 'application/json' } });
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.json.ready, false);

  // an official may read it too (the same permission as the analytics page); a gate attendant and a customer may not
  const official = { name: 'R. K. Sharma', office: 'Municipal Corporation', email: 'rk@gov.example.in', password: 'official-pass-1' };
  assert.equal((await s.post('/api/dashboard/officials', official, { headers: { cookie: admin, accept: 'application/json' } })).status, 201);
  const off = cookieOf(await s.post('/api/auth/login', { identifier: official.email, password: official.password }));
  assert.equal((await s.get('/api/dashboard/forecast', { headers: { cookie: off, accept: 'application/json' } })).status, 200);
  const att = { name: 'Ramesh Gate', email: 'gate@example.com', password: 'gate-pass-1234' };
  assert.equal((await s.post('/api/dashboard/attendants', att, { headers: { cookie: admin, accept: 'application/json' } })).status, 201);
  const gate = cookieOf(await s.post('/api/auth/login', { identifier: att.email, password: att.password }));
  assert.equal((await s.get('/api/dashboard/forecast', { headers: { cookie: gate, accept: 'application/json' } })).status, 403);
  const signup = await s.post('/api/auth/signup', { name: 'Asha Verma', email: 'asha@example.com', password: 'a-good-password' });
  assert.equal((await s.get('/api/dashboard/forecast', { headers: { cookie: cookieOf(signup), accept: 'application/json' } })).status, 403);

  // it is read-only: other methods are not routes
  assert.notEqual((await s.post('/api/dashboard/forecast', {}, { headers: { cookie: admin, accept: 'application/json' } })).status, 200);

  // real bookings flow into it
  const made = await s.post('/api/bookings', car());
  assert.equal((await pay(s, made, 'pay_fc1')).status, 200);
  const after = await s.get('/api/dashboard/forecast', { headers: { cookie: admin, accept: 'application/json' } });
  assert.equal(after.json.history.days, 0, 'one booking that is still to come is not history');
  assert.equal(after.json.paymentMode, 'razorpay');
});

test('with sample bookings the website produces a forecast, an error figure and a sample notice', async (t) => {
  const s = await makeSite({ env: { OPERATOR_PASSWORD: 'correct horse battery' } }); // no Razorpay keys: sample data is allowed
  t.after(() => s.close());
  s.bookings.addSampleData();
  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: 'correct horse battery' }));
  const r = await s.get('/api/dashboard/forecast', { headers: { cookie: admin, accept: 'application/json' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ready, true);
  assert.equal(r.json.sample.present, true);
  assert.equal(r.json.days.length, 7);
  assert.ok(r.json.accuracy.days >= 5);
  assert.equal(typeof r.json.accuracy.series.arrivals.wape, 'number');
  assert.ok(['low', 'medium', 'high'].includes(r.json.confidence));
});

test('the analytics page has the forecast section and its script, and nothing sits unfilled', async (t) => {
  const s = await makeSite({ env: { OPERATOR_PASSWORD: 'correct horse battery' } });
  t.after(() => s.close());
  const admin = cookieOf(await s.post('/api/auth/login', { identifier: 'operator', password: 'correct horse battery' }));
  const page = await s.get('/analytics', { headers: { cookie: admin, accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /id="fc-body"/);
  assert.match(page.text, /src="\/js\/forecast\.js"/);
  assert.doesNotMatch(page.text, /\{\{/);
  const js = await s.get('/js/forecast.js');
  assert.equal(js.status, 200);
  assert.doesNotMatch(js.text, /innerHTML|insertAdjacentHTML|document\.write/, 'everything from the server goes on the page as text');
  assert.ok(fs.existsSync(require('node:path').join(__dirname, '..', 'public', 'js', 'forecast.js')));
});
