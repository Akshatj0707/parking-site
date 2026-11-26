'use strict';

/*
 * A demand forecast for the next 7 days, how far off it has been lately, and price suggestions for the owner to think about.
 *
 * THE METHOD (deliberately plain, so it can be explained in one breath)
 *   "A Saturday looks like the last few Saturdays." The forecast for a day is the weighted average of the same weekday in the
 *   last four weeks (last week counts 4, the week before 3, then 2, then 1). When fewer than two of those weeks exist yet,
 *   it is the average of the last 7 days. Nothing is guessed from outside the bookings: no weather, no events.
 *   Bookings that are already paid for a coming day are a floor: the forecast is never lower than what is already booked.
 *
 * WHAT IS FORECAST (per lot day, from paid bookings, on the lot clock)
 *   arrivals   paid bookings that start that day
 *   bayHours   bay-hours booked that day (cars and two-wheelers together)
 *   peakCar    how full the 4-wheeler bays are in the busiest hour, in percent
 *   peakBike   the same for the 2-wheeler bays
 *
 * HOW GOOD IT IS (the error measure)
 *   The method is run again on each of the last 14 finished days, using only the days before it (a "back-test"), and compared
 *   with what really happened. Reported: MAE (the average miss, in the series' own unit) and WAPE (the total miss as a share of
 *   the total actual, so one empty day cannot blow it up). The same is done for the plainest guess, "the same as the same day
 *   last week", so it is clear whether the method earns its keep.
 *
 * PRICE SUGGESTIONS
 *   Only suggestions. This file never changes a price and nothing in the site reads them back. A day whose forecast busiest
 *   hour fills at least `highPercent` of the bays gets "consider a higher rate"; at most `lowPercent` gets "consider an offer";
 *   a step of `stepPercent`. No suggestions are made while the forecast is low-confidence.
 */

const S = require('../public/js/shared.js');
const { shiftDate } = require('./analytics');

const { HOUR, MIN, LOT } = S;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LAGS = [7, 14, 21, 28]; // days back that count as "the same weekday"
const WEIGHTS = [4, 3, 2, 1]; // the nearer week counts more
const MIN_HISTORY = 7; // days of history before any forecast is shown
const BACKTEST_DAYS = 14;
const HORIZON = 7; // today and the six days after it
const LEVEL_DAYS = 7; // the average used when there are not enough same weekdays

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const hourName = (hh) => `${hh % 12 === 0 ? 12 : hh % 12} ${hh < 12 ? 'am' : 'pm'}`;
const hourLabel = (hh) => `${hourName(hh)} – ${hourName((hh + 1) % 24)}`;

function dayInfo(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { dow, label: `${WEEKDAYS[dow]} ${d} ${MONTHS[m - 1]}` };
}
// Days between two 'YYYY-MM-DD' dates.
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

// ---- What each lot day looked like -------------------------------------------------------------------------------
// date -> { arrivals, hours: { car: [24 bay-hours], bike: [24 bay-hours] } }, from the paid bookings (the same rule as the analytics page).
function dayTable(bookings, off) {
  const offMs = off * MIN;
  const days = new Map();
  const get = (date) => {
    let rec = days.get(date);
    if (!rec) {
      rec = { arrivals: 0, hours: { car: new Array(24).fill(0), bike: new Array(24).fill(0) } };
      days.set(date, rec);
    }
    return rec;
  };
  let first = null;
  for (const b of bookings) {
    if (b.status !== 'paid' || !LOT[b.vehicle]) continue;
    const startDate = S.lotDateString(b.startMs, off);
    get(startDate).arrivals += 1;
    if (first === null || startDate < first) first = startDate;
    for (let slot = Math.floor((b.startMs + offMs) / HOUR); slot <= Math.floor((b.endMs - 1 + offMs) / HOUR); slot++) {
      const slotStart = slot * HOUR - offMs;
      const overlap = Math.min(b.endMs, slotStart + HOUR) - Math.max(b.startMs, slotStart);
      if (overlap <= 0) continue;
      get(S.lotDateString(slotStart, off)).hours[b.vehicle][((slot % 24) + 24) % 24] += overlap / HOUR;
    }
  }
  return { days, first };
}

const EMPTY = { arrivals: 0, hours: { car: new Array(24).fill(0), bike: new Array(24).fill(0) } };
const sum = (list) => list.reduce((n, x) => n + x, 0);
const peakPercent = (rec, vehicle) => (Math.max(...rec.hours[vehicle]) / LOT[vehicle].total) * 100;

// The four things that are forecast, each a number taken from one day's record.
const SERIES = {
  arrivals: (rec) => rec.arrivals,
  bayHours: (rec) => sum(rec.hours.car) + sum(rec.hours.bike),
  peakCar: (rec) => peakPercent(rec, 'car'),
  peakBike: (rec) => peakPercent(rec, 'bike'),
};

// ---- The method -----------------------------------------------------------------------------------------------------
// `pick` turns a day's record into a number. History is every day from `first` up to, not including, `cutoff`.
function predict(table, pick, target, cutoff) {
  const { days, first } = table;
  if (first === null || daysBetween(first, cutoff) < MIN_HISTORY) return null;
  const valueOn = (date) => pick(days.get(date) || EMPTY);
  let weighted = 0;
  let weight = 0;
  let found = 0;
  LAGS.forEach((lag, i) => {
    const date = shiftDate(target, -lag);
    if (date >= first && date < cutoff) {
      weighted += WEIGHTS[i] * valueOn(date);
      weight += WEIGHTS[i];
      found += 1;
    }
  });
  if (found >= 2) return { value: weighted / weight, method: 'same-weekday' };
  let total = 0;
  for (let k = 1; k <= LEVEL_DAYS; k++) total += valueOn(shiftDate(cutoff, -k));
  return { value: total / LEVEL_DAYS, method: 'recent-average' };
}

// ---- How far off it has been ------------------------------------------------------------------------------------------
function backtest(table, today) {
  const { days, first } = table;
  const targets = [];
  for (let k = BACKTEST_DAYS; k >= 1; k--) {
    const date = shiftDate(today, -k);
    if (first !== null && daysBetween(first, date) >= MIN_HISTORY) targets.push(date);
  }
  const out = {};
  for (const [name, pick] of Object.entries(SERIES)) {
    let miss = 0;
    let naiveMiss = 0;
    let actual = 0;
    let signed = 0;
    for (const date of targets) {
      const a = pick(days.get(date) || EMPTY);
      const f = predict(table, pick, date, date).value;
      const naive = pick(days.get(shiftDate(date, -7)) || EMPTY);
      miss += Math.abs(f - a);
      naiveMiss += Math.abs(naive - a);
      signed += f - a;
      actual += a;
    }
    const n = targets.length;
    out[name] = n
      ? { mae: round1(miss / n), wape: actual > 0 ? round3(miss / actual) : null, naiveWape: actual > 0 ? round3(naiveMiss / actual) : null, bias: round1(signed / n) }
      : { mae: null, wape: null, naiveWape: null, bias: null };
  }
  return { days: targets.length, series: out };
}

function confidenceOf(historyDays, accuracy) {
  const wape = accuracy.series.bayHours.wape;
  if (historyDays < 14 || accuracy.days < 5 || wape === null) return 'low';
  if (wape <= 0.2 && historyDays >= 28) return 'high';
  if (wape <= 0.4) return 'medium';
  return 'low';
}

// ---- The forecast and the suggestions -------------------------------------------------------------------------------------
function forecast(bookings, { now, config }) {
  const off = config.utcOffsetMinutes;
  const today = S.lotDateString(now, off);
  const settings = { highPercent: config.forecast.highPercent, lowPercent: config.forecast.lowPercent, stepPercent: config.forecast.stepPercent };
  const table = dayTable(bookings, off);
  const sample = bookings.some((b) => b.sample);
  const historyDays = table.first !== null && table.first < today ? daysBetween(table.first, today) : 0;
  const base = { serverTime: now, utcOffsetMinutes: off, today, history: { days: historyDays, from: historyDays ? table.first : null }, settings, sample: { present: sample }, horizon: HORIZON };
  if (historyDays < MIN_HISTORY) {
    return {
      ...base,
      ready: false,
      reason: `A forecast needs at least ${MIN_HISTORY} days of bookings. There ${historyDays === 1 ? 'is 1 day' : 'are ' + historyDays + ' days'} so far.`,
      confidence: 'low',
      days: [],
      accuracy: { days: 0, series: {} },
      suggestions: [],
      notes: [],
    };
  }

  const accuracy = backtest(table, today);
  const confidence = confidenceOf(historyDays, accuracy);
  const rows = [];
  const suggestions = [];

  for (let k = 0; k < HORIZON; k++) {
    const date = shiftDate(today, k);
    const info = dayInfo(date);
    const dayType = config.weekendDays.includes(info.dow) ? 'weekend' : 'weekday';
    const booked = table.days.get(date) || EMPTY; // what is already paid for (a floor)
    const row = { date, label: info.label, dayType, method: null };

    for (const name of ['arrivals', 'bayHours']) {
      const p = predict(table, SERIES[name], date, today);
      const soFar = SERIES[name](booked);
      row.method = p.method;
      row[name] = { expected: round1(Math.max(p.value, soFar)), bookedSoFar: round1(soFar), floored: soFar > p.value };
    }

    for (const vehicle of ['car', 'bike']) {
      const name = vehicle === 'car' ? 'peakCar' : 'peakBike';
      const p = predict(table, SERIES[name], date, today);
      const soFar = SERIES[name](booked);
      // the hour of the day that is usually the fullest on this weekday
      let bestHour = 0;
      let best = -1;
      for (let hh = 0; hh < 24; hh++) {
        const ph = predict(table, (rec) => rec.hours[vehicle][hh], date, today).value;
        const mix = Math.max(ph, booked.hours[vehicle][hh]);
        if (mix > best) {
          best = mix;
          bestHour = hh;
        }
      }
      const percent = Math.min(100, Math.max(p.value, soFar));
      row[vehicle] = { peakPercent: round1(percent), bookedPercent: round1(soFar), peakHour: best > 0 ? { hour: bestHour, label: hourLabel(bestHour) } : null, rate: config.rates[vehicle][dayType], suggestion: { action: 'keep', rate: config.rates[vehicle][dayType] } };
    }
    rows.push(row);
  }

  // Suggestions come after all seven days are known, because "quiet" means quiet compared with the rest of the week.
  const notes = [];
  if (confidence === 'low') notes.push('The forecast is not reliable enough yet (too few days of bookings, or it has been missing by too much), so no price suggestions are made.');
  for (const vehicle of ['car', 'bike']) {
    const word = vehicle === 'car' ? '4-wheeler' : '2-wheeler';
    const average = rows.reduce((n, r) => n + r[vehicle].peakPercent, 0) / rows.length;
    if (confidence !== 'low' && rows.every((r) => r[vehicle].peakPercent <= settings.lowPercent)) {
      notes.push(`The ${word} bays are expected to stay under ${settings.lowPercent}% full on every one of the next ${HORIZON} days. Changing the price on single days will not fill them; it is a question of attracting more customers overall.`);
    }
    for (const r of rows) {
      const view = r[vehicle];
      const percent = view.peakPercent;
      const rate = view.rate;
      if (confidence === 'low') break;
      if (percent >= settings.highPercent) view.suggestion = { action: 'raise', rate: Math.max(rate + 1, Math.round(rate * (1 + settings.stepPercent / 100))) };
      else if (average > 0 && percent <= settings.lowPercent && percent <= average * 0.7 && rate > 1) view.suggestion = { action: 'lower', rate: Math.min(rate - 1, Math.max(1, Math.round(rate * (1 - settings.stepPercent / 100)))) };
      if (view.suggestion.action === 'keep') continue;
      const raise = view.suggestion.action === 'raise';
      suggestions.push({
        date: r.date,
        label: r.label,
        vehicle,
        action: view.suggestion.action,
        from: rate,
        to: view.suggestion.rate,
        text: raise
          ? `${r.label}: the ${word} bays are expected to be ${Math.round(percent)}% full at the busiest time${view.peakHour ? ' (' + view.peakHour.label + ')' : ''}. You could try ₹${view.suggestion.rate} an hour instead of ₹${rate}.`
          : `${r.label}: a quiet day for the ${word} bays, at most ${Math.round(percent)}% full while the week averages ${Math.round(average)}%. You could try an offer of ₹${view.suggestion.rate} an hour instead of ₹${rate}.`,
      });
    }
  }
  suggestions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.vehicle < b.vehicle ? -1 : 1));

  return { ...base, ready: true, confidence, days: rows, accuracy, suggestions, notes };
}

module.exports = { forecast, predict, backtest, dayTable, confidenceOf, SERIES, LAGS, WEIGHTS, MIN_HISTORY, BACKTEST_DAYS, HORIZON };
