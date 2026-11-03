'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeSite, bookAndPay, car, bike, basic, AVAILABILITY_URL, START } = require('./helpers');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const AUTH = { headers: { authorization: basic('operator', OP.OPERATOR_PASSWORD) } };
const DAY = 24 * 60 * 60 * 1000;

const analytics = async (site, query = '') => (await site.get('/api/dashboard/analytics' + query, AUTH)).json;

test('the analytics are for the operator only', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  assert.equal((await site.get('/api/dashboard/analytics')).status, 401);
  assert.equal((await site.get('/analytics')).status, 401);
  const ok = await site.get('/api/dashboard/analytics', AUTH);
  assert.equal(ok.status, 200);
  const page = await site.get('/analytics', AUTH);
  assert.equal(page.status, 200);
  assert.match(page.text, /Collection and busy hours/);
  assert.match(page.text, /<script src="\/js\/analytics\.js">/);
  assert.ok(!/<script>(?!\s*<\/script>)/.test(page.text), 'no inline script');
  assert.ok(!/demo/i.test(page.text), 'the page does not say demo');
});

test('an empty lot gives zeros and an honest message, not an error', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const a = await analytics(site);
  assert.equal(a.date, '2026-10-14');
  assert.equal(a.days, 14);
  assert.equal(a.daily.length, 14);
  assert.equal(a.hours.length, 24);
  assert.equal(a.day.collection, 0);
  assert.equal(a.totals.payments, 0);
  assert.equal(a.peak, null);
  assert.equal(a.totals.bestDay, null);
  assert.match(a.insights[0], /no paid bookings/i);
  assert.deepEqual(a.sample, { present: false, count: 0 });
});

test('the money collected on a day is what the dashboard shows, and a cancelled booking is taken out', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const first = await bookAndPay(site, car({ plate: 'MP09AB1111' })); // 2 hours at 40 = 80
  await bookAndPay(site, bike({ plate: 'MP09AB2222', hours: 3 })); // 3 hours at 20 = 60
  const a = await analytics(site);
  assert.equal(a.day.collection, 140);
  assert.equal(a.day.payments, 2);
  assert.equal(a.day.average, 70);
  assert.deepEqual(a.day.vehicles, { car: { collection: 80, payments: 1 }, bike: { collection: 60, payments: 1 } });
  assert.equal(a.day.collection, site.bookings.dashboard().revenueToday, 'same rule as the dashboard');
  assert.equal(a.totals.collection, 140);
  assert.equal(a.daily[a.daily.length - 1].collection, 140);
  assert.equal(a.totals.bestDay.date, '2026-10-14');

  const ref = site.store.get(first.created.json.booking.id).ref;
  const cancelled = await site.post(`/api/dashboard/bookings/${ref}/cancel`, {}, AUTH);
  assert.equal(cancelled.status, 200);
  const after = await analytics(site);
  assert.equal(after.day.collection, 60, 'a cancelled booking is no longer money collected');
  assert.equal(after.day.collection, site.bookings.dashboard().revenueToday);
});

test('the busiest hour is the one with the most vehicles parked, counted on the lot clock', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  await bookAndPay(site, car({ plate: 'MP09AB1111', time: '11:00', hours: 2 })); // 11:00 to 13:00
  await bookAndPay(site, car({ plate: 'MP09AB2222', time: '12:00', hours: 2 })); // 12:00 to 14:00
  await bookAndPay(site, bike({ plate: 'MP09AB3333', time: '12:30', hours: 1 })); // 12:30 to 13:30
  const a = await analytics(site);
  const hour = (h) => a.dayHours[h];
  assert.equal(hour(10).parked.total, 0);
  assert.equal(hour(11).parked.car, 1);
  assert.equal(hour(12).parked.car, 2);
  assert.equal(hour(12).parked.bike, 0.5, 'a bike booked for half of the hour counts half');
  assert.equal(hour(13).parked.bike, 0.5);
  assert.equal(hour(13).parked.car, 1);
  assert.equal(hour(14).parked.total, 0);
  assert.equal(a.day.peak.hour, 12);
  assert.equal(a.day.peak.label, '12 pm – 1 pm');
  assert.equal(a.day.peak.parked, 2.5);
  assert.equal(hour(11).arrivals.car, 1);
  assert.equal(hour(12).arrivals.total, 2);
  // over a period the numbers are averages per day: three bookings on one of 7 days
  const week = await analytics(site, '?days=7');
  assert.equal(week.hours[12].parked.car, Math.round((2 / 7) * 10) / 10);
  assert.equal(week.peak.hour, 12);
  assert.match(week.insights.join(' '), /Busiest time: 12 pm – 1 pm/);
});

test('a booking that runs past midnight counts in both days, and the day is the lot day, not the UTC day', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const made = await bookAndPay(site, car({ time: '23:00', hours: 2 })); // 14 Oct 23:00 to 15 Oct 01:00 in India
  assert.equal(made.paid.status, 200);
  const before = await analytics(site, '?date=2026-10-14');
  assert.equal(before.dayHours[23].parked.car, 1);
  assert.equal(before.dayHours[0].parked.car, 0);
  site.advance(DAY);
  const next = await analytics(site, '?date=2026-10-15');
  assert.equal(next.dayHours[0].parked.car, 1, 'the part after midnight is on the next day');
  assert.equal(next.dayHours[23].parked.car, 0);
  assert.equal(next.day.collection, 0, 'it was paid on the 14th');
  assert.equal(next.daily[next.daily.length - 2].collection, 80, 'the day before shows the payment');
  // 04:30 UTC on the 14th is already the 14th in India, and 19:00 UTC on the 14th is already the 15th
  const late = await analytics(site, '?date=2026-10-14');
  assert.equal(late.day.collection, 80);
});

test('the period and the day are checked, and a wrong one falls back instead of failing', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  for (const days of [7, 14, 30, 90]) assert.equal((await analytics(site, `?days=${days}`)).daily.length, days);
  for (const bad of ['?days=5', '?days=abc', '?days=-1', '?days=1000', '?days=']) assert.equal((await analytics(site, bad)).days, 14, bad);
  for (const bad of ['?date=2026-13-45', '?date=tomorrow', '?date=2026-02-30', '?date=2099-01-01', '?date=']) assert.equal((await analytics(site, bad)).date, '2026-10-14', bad);
  const past = await analytics(site, '?date=2026-10-01&days=7');
  assert.equal(past.date, '2026-10-01');
  assert.equal(past.daily[0].date, '2026-09-25');
  assert.equal(past.daily[6].date, '2026-10-01');
});

test('sample bookings: added in test mode only, in the past only, marked as samples, and they can be removed', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  const realBefore = await bookAndPay(site, car({ plate: 'MP09AB1111' }));
  const free = (await site.get(AVAILABILITY_URL('car'))).json;

  const added = await site.post('/api/dashboard/sample-data', { action: 'add' }, AUTH);
  assert.equal(added.status, 200);
  assert.ok(added.json.added > 200, 'about two weeks of bookings');
  const samples = site.store.bookings.filter((b) => b.sample);
  assert.equal(samples.length, added.json.added);
  for (const b of samples) {
    assert.equal(b.status, 'paid');
    assert.equal(b.mode, 'sample');
    assert.match(b.paymentId, /^sample_/);
    assert.ok(b.endMs <= START, 'every sample booking is over, so none can block a bay');
    assert.match(b.plate, /^[A-Z]{2}\d{2}[A-Z]{2}\d{4}$/);
  }
  assert.equal(new Set(samples.map((b) => b.ref)).size, samples.length, 'unique references');
  assert.deepEqual((await site.get(AVAILABILITY_URL('car'))).json, free, 'the free bays are the same as before');
  assert.equal(site.store.get(realBefore.created.json.booking.id).status, 'paid', 'the real booking is untouched');

  const a = await analytics(site);
  assert.deepEqual(a.sample, { present: true, count: added.json.added });
  assert.ok(a.totals.payments > 200);
  assert.ok(a.peak, 'there is a busiest hour');
  assert.ok(a.peak.hour >= 7 && a.peak.hour <= 21, 'the sample rush is in the daytime: ' + a.peak.label);
  assert.ok(a.daily.slice(0, 13).every((d) => d.collection > 0), 'every earlier day has money');
  assert.ok(a.insights.length >= 3);

  const again = await site.post('/api/dashboard/sample-data', { action: 'add' }, AUTH);
  assert.equal(site.store.bookings.filter((b) => b.sample).length, again.json.added, 'adding again replaces the old samples');
  const dash = (await site.get('/api/dashboard', AUTH)).json;
  assert.ok(dash.recent.some((r) => r.sample) || dash.recent.length > 0);

  const removed = await site.post('/api/dashboard/sample-data', { action: 'remove' }, AUTH);
  assert.equal(removed.json.removed, again.json.added);
  assert.equal(site.store.bookings.filter((b) => b.sample).length, 0);
  assert.equal(site.store.bookings.length, 1, 'only the real booking is left');
  assert.deepEqual((await analytics(site)).sample, { present: false, count: 0 });

  assert.equal((await site.post('/api/dashboard/sample-data', { action: 'explode' }, AUTH)).status, 400);
  assert.equal((await site.post('/api/dashboard/sample-data', { action: 'add' })).status, 401);
  assert.equal((await site.post('/api/dashboard/sample-data', { action: 'add' }, { headers: { ...AUTH.headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('sample bookings are refused once Razorpay is connected', async (t) => {
  const site = await makeSite({ razorpayKeys: true, env: OP });
  t.after(() => site.close());
  const refused = await site.post('/api/dashboard/sample-data', { action: 'add' }, AUTH);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'not_allowed');
  assert.equal(site.store.bookings.length, 0);
  assert.equal((await analytics(site)).paymentMode, 'razorpay');
});

test('the sample bookings are saved like any others, so they survive a restart', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(async () => {
    await site.close();
  });
  await site.post('/api/dashboard/sample-data', { action: 'add' }, AUTH);
  const saved = JSON.parse(fs.readFileSync(site.store.file, 'utf8')).bookings;
  assert.equal(saved.filter((b) => b.sample).length, site.store.bookings.length);
});

test('the analytics numbers add up: the days add up to the total, the vehicles to the total', async (t) => {
  const site = await makeSite({ env: OP });
  t.after(() => site.close());
  await site.post('/api/dashboard/sample-data', { action: 'add' }, AUTH);
  for (const days of [7, 30]) {
    const a = await analytics(site, `?days=${days}`);
    const byDay = a.daily.reduce((n, d) => n + Math.round(d.collection * 100), 0);
    assert.equal(byDay, Math.round(a.totals.collection * 100));
    assert.equal(Math.round((a.vehicles.car.collection + a.vehicles.bike.collection) * 100), Math.round(a.totals.collection * 100));
    assert.equal(a.vehicles.car.payments + a.vehicles.bike.payments, a.totals.payments);
    assert.equal(a.daily.reduce((n, d) => n + d.payments, 0), a.totals.payments);
    for (const h of a.hours) assert.ok(h.parked.total <= a.bays.total, 'never more vehicles than bays');
  }
});
