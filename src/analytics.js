'use strict';

/*
 * Numbers for the operator's analytics page: how much was collected on a day, and which hours are the busiest.
 * Everything here is worked out from the bookings, on the lot's own clock (config.utcOffsetMinutes).
 *
 *   Money      a payment counts on the lot day it was received (paidAt). Only bookings that are still "paid" count, so a
 *              booking that was cancelled and refunded is taken out. This is the same rule as the dashboard's "today".
 *   Busy hours a vehicle is "parked" in an hour for the part of that hour that its booking covers (a booking is a time
 *              window, not a sensor reading). For a range of days the figure is the average per day.
 */

const crypto = require('crypto');
const S = require('../public/js/shared.js');

const { MIN, HOUR, DAY, LOT } = S;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANGES = [7, 14, 30, 90];
const TOTAL_BAYS = LOT.car.total + LOT.bike.total;

const hourName = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;
const hourLabel = (h) => `${hourName(h)} – ${hourName((h + 1) % 24)}`;
const round1 = (n) => Math.round(n * 10) / 10;
const rupees = (paise) => Math.round(paise) / 100;
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// 'YYYY-MM-DD' arithmetic on the calendar only
function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && shiftDate(s, 0) === s;
function dateLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

function analytics(bookings, { now, config, query = {} }) {
  const off = config.utcOffsetMinutes;
  const offMs = off * MIN;
  const today = S.lotDateString(now, off);
  const days = RANGES.includes(Number(query.days)) ? Number(query.days) : 14;
  let date = validDate(query.date) ? query.date : today;
  if (date > today) date = today;
  const first = shiftDate(date, -(days - 1));
  const startMs = S.startMsFromLot(first, '00:00', off);
  const focusStart = S.startMsFromLot(date, '00:00', off);
  const endMs = focusStart + DAY;

  const daily = [];
  const index = {};
  for (let i = 0; i < days; i++) {
    const d = shiftDate(first, i);
    index[d] = i;
    daily.push({ date: d, label: dateLabel(d), paise: 0, payments: 0, refundedPaise: 0 });
  }
  const vehicles = { car: { paise: 0, payments: 0 }, bike: { paise: 0, payments: 0 } };
  const dayVehicles = { car: { paise: 0, payments: 0 }, bike: { paise: 0, payments: 0 } };
  const blank = () => Array.from({ length: 24 }, (_, hour) => ({ hour, arrivals: { car: 0, bike: 0 }, parked: { car: 0, bike: 0 } }));
  const range = blank();
  const focus = blank();
  let sampleCount = 0;

  for (const b of bookings) {
    if (b.sample) sampleCount += 1;
    if (b.status === 'refunded' && b.refundedAt >= startMs && b.refundedAt < endMs) {
      const i = index[S.lotDateString(b.refundedAt, off)];
      if (i !== undefined) daily[i].refundedPaise += b.amountPaise;
    }
    if (b.status !== 'paid') continue;

    if (b.paidAt >= startMs && b.paidAt < endMs) {
      const i = index[S.lotDateString(b.paidAt, off)];
      if (i !== undefined) {
        daily[i].paise += b.amountPaise;
        daily[i].payments += 1;
        vehicles[b.vehicle].paise += b.amountPaise;
        vehicles[b.vehicle].payments += 1;
        if (b.paidAt >= focusStart) {
          dayVehicles[b.vehicle].paise += b.amountPaise;
          dayVehicles[b.vehicle].payments += 1;
        }
      }
    }

    if (b.endMs <= startMs || b.startMs >= endMs) continue;
    if (b.startMs >= startMs) {
      const h = (((Math.floor((b.startMs + offMs) / HOUR) % 24) + 24) % 24);
      range[h].arrivals[b.vehicle] += 1;
      if (b.startMs >= focusStart) focus[h].arrivals[b.vehicle] += 1;
    }
    const from = Math.max(b.startMs, startMs);
    const to = Math.min(b.endMs, endMs);
    for (let slot = Math.floor((from + offMs) / HOUR); slot <= Math.floor((to - 1 + offMs) / HOUR); slot++) {
      const slotStart = slot * HOUR - offMs;
      const overlap = Math.min(to, slotStart + HOUR) - Math.max(from, slotStart);
      if (overlap <= 0) continue;
      const h = ((slot % 24) + 24) % 24;
      range[h].parked[b.vehicle] += overlap / HOUR;
      if (slotStart >= focusStart) focus[h].parked[b.vehicle] += overlap / HOUR;
    }
  }

  const rows = (src, divisor) =>
    src.map((x) => {
      const car = x.parked.car / divisor;
      const bike = x.parked.bike / divisor;
      const arrivals = { car: round1(x.arrivals.car / divisor), bike: round1(x.arrivals.bike / divisor) };
      arrivals.total = round1(arrivals.car + arrivals.bike);
      return {
        hour: x.hour,
        label: hourLabel(x.hour),
        arrivals,
        parked: { car: round1(car), bike: round1(bike), total: round1(car + bike) },
        utilisation: round1(((car + bike) / TOTAL_BAYS) * 100),
      };
    });
  const hours = rows(range, days);
  const dayHours = rows(focus, 1);

  const peakOf = (list) => {
    let best = null;
    for (const r of list) if (r.parked.total > 0 && (!best || r.parked.total > best.parked.total)) best = r;
    if (!best) return null;
    // the run of hours around the peak that are nearly as busy
    const limit = best.parked.total * 0.75;
    let lo = best.hour;
    let hi = best.hour;
    while (lo > 0 && list[lo - 1].parked.total >= limit) lo -= 1;
    while (hi < 23 && list[hi + 1].parked.total >= limit) hi += 1;
    return {
      hour: best.hour,
      label: best.label,
      parked: best.parked.total,
      utilisation: best.utilisation,
      window: { from: lo, to: hi + 1, label: lo === hi ? best.label : `${hourName(lo)} – ${hourName((hi + 1) % 24)}` },
    };
  };
  const peak = peakOf(hours);
  const dayPeak = peakOf(dayHours);
  let mostArrivals = null;
  for (const r of hours) if (r.arrivals.total > 0 && (!mostArrivals || r.arrivals.total > mostArrivals.arrivals.total)) mostArrivals = r;

  const sumPaise = daily.reduce((n, d) => n + d.paise, 0);
  const sumPayments = daily.reduce((n, d) => n + d.payments, 0);
  let best = null;
  for (const d of daily) if (d.paise > 0 && (!best || d.paise > best.paise)) best = d;
  const todayRow = daily[days - 1];
  const before = days > 1 ? daily[days - 2] : null;

  const insights = [];
  if (!sumPayments) {
    insights.push('There are no paid bookings in this period yet. Once customers book and pay, the busiest hours and the money collected show up here.');
  } else {
    insights.push(`On ${todayRow.label} the lot collected ${inr(rupees(todayRow.paise))} from ${todayRow.payments} payment${todayRow.payments === 1 ? '' : 's'}.` +
      (before && before.payments ? ` That is ${todayRow.paise >= before.paise ? inr(rupees(todayRow.paise - before.paise)) + ' more' : inr(rupees(before.paise - todayRow.paise)) + ' less'} than ${before.label}.` : ''));
    if (peak) {
      insights.push(`Busiest time: ${peak.label}, with about ${Math.max(1, Math.round(peak.parked))} vehicle${Math.round(peak.parked) === 1 ? '' : 's'} parked at once on an average day (${peak.utilisation}% of all ${TOTAL_BAYS} bays).`);
      if (peak.window.to - peak.window.from > 1) insights.push(`The busy stretch is about ${peak.window.label}.`);
    }
    if (mostArrivals) insights.push(`Most vehicles arrive between ${hourName(mostArrivals.hour)} and ${hourName((mostArrivals.hour + 1) % 24)}, about ${mostArrivals.arrivals.total} a day.`);
    if (best && days > 1) insights.push(`Best day in the last ${days} days: ${best.label}, ${inr(rupees(best.paise))}.`);
  }

  const veh = (v) => ({ collection: rupees(v.paise), payments: v.payments });
  return {
    serverTime: now,
    utcOffsetMinutes: off,
    today,
    date,
    days,
    from: first,
    bays: { car: LOT.car.total, bike: LOT.bike.total, total: TOTAL_BAYS },
    day: {
      date,
      label: dateLabel(date),
      collection: rupees(todayRow.paise),
      payments: todayRow.payments,
      average: todayRow.payments ? rupees(todayRow.paise / todayRow.payments) : 0,
      refunded: rupees(todayRow.refundedPaise),
      vehicles: { car: veh(dayVehicles.car), bike: veh(dayVehicles.bike) },
      previous: before ? { date: before.date, label: before.label, collection: rupees(before.paise) } : null,
      peak: dayPeak,
    },
    daily: daily.map((d) => ({ date: d.date, label: d.label, collection: rupees(d.paise), payments: d.payments })),
    hours,
    dayHours,
    vehicles: { car: veh(vehicles.car), bike: veh(vehicles.bike) },
    totals: {
      collection: rupees(sumPaise),
      payments: sumPayments,
      average: sumPayments ? rupees(sumPaise / sumPayments) : 0,
      bestDay: best ? { date: best.date, label: best.label, collection: rupees(best.paise) } : null,
    },
    peak,
    mostArrivals: mostArrivals ? { hour: mostArrivals.hour, label: mostArrivals.label, perDay: mostArrivals.arrivals.total } : null,
    insights,
    sample: { present: sampleCount > 0, count: sampleCount },
  };
}

// ---- Sample bookings for a demonstration --------------------------------------------------------------------
// Only for a site whose payments are simulated. They are marked sample:true everywhere, they are all in the past (so
// they never block a bay), and the operator can remove them with one button.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKDAY_SHAPE = [0.1, 0.05, 0.03, 0.03, 0.05, 0.2, 0.6, 1.2, 2.4, 3.0, 2.6, 2.0, 1.8, 1.6, 1.4, 1.6, 2.0, 3.2, 3.4, 2.8, 1.8, 1.0, 0.5, 0.2];
const WEEKEND_SHAPE = [0.1, 0.05, 0.03, 0.03, 0.03, 0.1, 0.2, 0.5, 0.9, 1.4, 1.9, 2.4, 2.8, 3.0, 3.0, 2.8, 2.6, 2.8, 3.2, 3.0, 2.2, 1.4, 0.7, 0.3];
const STATES = ['MP09', 'MP04', 'MP07', 'MH12', 'DL01', 'GJ05', 'RJ14', 'UP32'];
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

function sampleBookings({ existing, now, config, newRef, days = 14, seed = 20261103 }) {
  const rng = mulberry32(seed);
  const off = config.utcOffsetMinutes;
  const today = S.lotDateString(now, off);
  const poisson = (lambda) => {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= rng();
    } while (p > limit);
    return k - 1;
  };
  const pick = (weights) => {
    let r = rng() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };

  // when each bay is already taken (real bookings and the ones made here)
  const busy = { car: new Map(), bike: new Map() };
  const take = (vehicle, bay, from, to) => {
    if (!busy[vehicle].has(bay)) busy[vehicle].set(bay, []);
    busy[vehicle].get(bay).push([from, to]);
  };
  const free = (vehicle, bay, from, to) => !(busy[vehicle].get(bay) || []).some(([a, b]) => a < to && from < b);
  for (const b of existing) {
    if (b.status === 'paid' || (b.status === 'pending' && b.holdUntil > now)) take(b.vehicle, b.bay, b.startMs, b.endMs);
  }

  const plates = new Set(existing.map((b) => b.plate));
  const out = [];
  const used = new Set();
  const refFor = () => {
    for (;;) {
      const ref = newRef();
      if (!used.has(ref)) {
        used.add(ref);
        return ref;
      }
    }
  };
  const newPlate = () => {
    for (;;) {
      const plate = STATES[Math.floor(rng() * STATES.length)] + LETTERS[Math.floor(rng() * LETTERS.length)] + LETTERS[Math.floor(rng() * LETTERS.length)] + String(1000 + Math.floor(rng() * 9000));
      if (S.isValidPlate(plate) && !plates.has(plate)) {
        plates.add(plate);
        return plate;
      }
    }
  };

  const hoursOptions = config.hoursOptions;
  const hourWeights = [0.3, 0.35, 0.2, 0.15];
  for (let back = days; back >= 0; back--) {
    const date = shiftDate(today, -back);
    const dayStart = S.startMsFromLot(date, '00:00', off);
    const dow = new Date(dayStart + off * MIN).getUTCDay();
    const weekend = config.weekendDays.includes(dow);
    const shape = weekend ? WEEKEND_SHAPE : WEEKDAY_SHAPE;
    const shapeSum = shape.reduce((a, b) => a + b, 0);
    const target = (weekend ? 95 : 72) * (0.85 + rng() * 0.3);
    for (let h = 0; h < 24; h++) {
      const arrivals = poisson((shape[h] / shapeSum) * target);
      for (let i = 0; i < arrivals; i++) {
        const vehicle = rng() < 0.45 ? 'car' : 'bike';
        const hours = hoursOptions[Math.min(pick(hourWeights), hoursOptions.length - 1)];
        const startMs = dayStart + h * HOUR + Math.floor(rng() * (60 / config.slotMinutes)) * config.slotMinutes * MIN;
        const endMs = startMs + hours * HOUR;
        if (endMs > now - 5 * MIN) continue; // only bookings that are already over
        const total = LOT[vehicle].total;
        const from = Math.floor(rng() * total);
        let bay = null;
        for (let k = 0; k < total && !bay; k++) {
          const candidate = S.bayId(vehicle, ((from + k) % total) + 1);
          if (free(vehicle, candidate, startMs, endMs)) bay = candidate;
        }
        if (!bay) continue;
        take(vehicle, bay, startMs, endMs);
        const price = S.priceFor(vehicle, startMs, hours, config);
        const paidAt = startMs - (5 + Math.floor(rng() * 175)) * MIN;
        out.push({
          id: 'bk_' + crypto.randomBytes(8).toString('hex'),
          ref: refFor(),
          vehicle,
          bay,
          plate: newPlate(),
          startMs,
          endMs,
          hours,
          dayType: price.dayType,
          rate: price.rate,
          amountPaise: price.paise,
          status: 'paid',
          createdAt: paidAt - 2 * MIN,
          holdUntil: paidAt + config.holdMinutes * MIN,
          orderId: null,
          paymentId: 'sample_' + crypto.randomBytes(6).toString('hex'),
          paidAt,
          mode: 'sample',
          sample: true,
        });
      }
    }
  }
  return out;
}

module.exports = { analytics, sampleBookings, hourLabel, shiftDate, RANGES };
