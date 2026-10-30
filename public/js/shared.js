/*
 * Code shared by the server (loaded with require) and the browser (loaded with a script tag).
 * Keep it free of other dependencies. The server always has the final say on prices and bookings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BayfindShared = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // The lot. To change the number of bays or the zone names, edit this block.
  // total must equal perZone multiplied by the number of zones.
  const LOT = {
    car: { label: '4-wheeler', prefix: 'C', total: 200, perZone: 50, zones: ['Level 1', 'Level 2', 'Level 3', 'Level 4'] },
    bike: { label: '2-wheeler', prefix: 'B', total: 250, perZone: 50, zones: ['Zone A', 'Zone B', 'Zone C', 'Zone D', 'Zone E'] },
  };
  const VEHICLES = ['car', 'bike'];

  // ---- Vehicle numbers ------------------------------------------------------------------
  // Standard Indian format: state code, district number, optional series letters, four digits.
  // Examples: MP 09 AB 1234, KA 01 1234, DL1CAB1234. BH-series plates are not supported.
  const PLATE_RE = /^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{4})$/;

  function normalizePlate(input) {
    return String(input == null ? '' : input).slice(0, 40).toUpperCase().replace(/[\s-]+/g, '');
  }

  function isValidPlate(normalized) {
    return PLATE_RE.test(normalized);
  }

  function formatPlate(normalized) {
    const m = PLATE_RE.exec(normalized);
    return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') : normalized;
  }

  // ---- Bays and zones -------------------------------------------------------------------
  function pad3(n) {
    return (n < 10 ? '00' : n < 100 ? '0' : '') + n;
  }

  function bayId(vehicle, n) {
    return LOT[vehicle].prefix + pad3(n);
  }

  function parseBay(id) {
    const m = /^([A-Z])([0-9]{3})$/.exec(String(id || ''));
    if (!m) return null;
    const vehicle = VEHICLES.find((v) => LOT[v].prefix === m[1]);
    if (!vehicle) return null;
    const n = parseInt(m[2], 10);
    if (n < 1 || n > LOT[vehicle].total) return null;
    return { vehicle, n, zone: Math.floor((n - 1) / LOT[vehicle].perZone) };
  }

  // ---- Lot time -------------------------------------------------------------------------
  // The lot runs on one clock (India Standard Time by default, UTC+05:30). Every date, time
  // and weekday on the site is worked out on that clock, whatever the visitor's device says.
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function two(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function lotParts(ms, offsetMin) {
    const d = new Date(ms + offsetMin * MIN);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
  }

  function lotDateString(ms, offsetMin) {
    const p = lotParts(ms, offsetMin);
    return p.y + '-' + two(p.mo) + '-' + two(p.d);
  }

  // 'YYYY-MM-DD' and 'HH:MM' on the lot clock -> a UTC timestamp in milliseconds (NaN if malformed).
  function startMsFromLot(dateStr, timeStr, offsetMin) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    const tm = /^(\d{2}):(\d{2})$/.exec(timeStr || '');
    if (!dm || !tm) return NaN;
    return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]) - offsetMin * MIN;
  }

  function slotFloor(ms, offsetMin, stepMin) {
    const off = offsetMin * MIN;
    const step = stepMin * MIN;
    return Math.floor((ms + off) / step) * step - off;
  }

  function formatTime(ms, offsetMin) {
    const p = lotParts(ms, offsetMin);
    return (p.h % 12 || 12) + ':' + two(p.mi) + ' ' + (p.h < 12 ? 'am' : 'pm');
  }

  function formatDate(ms, offsetMin) {
    const p = lotParts(ms, offsetMin);
    return DOW[p.dow] + ' ' + p.d + ' ' + MON[p.mo - 1];
  }

  function formatWindow(startMs, endMs, offsetMin) {
    const a = lotParts(startMs, offsetMin);
    const b = lotParts(endMs, offsetMin);
    const sameDay = a.y === b.y && a.mo === b.mo && a.d === b.d;
    return (
      formatDate(startMs, offsetMin) + ', ' + formatTime(startMs, offsetMin) + ' – ' +
      (sameDay ? '' : formatDate(endMs, offsetMin) + ', ') + formatTime(endMs, offsetMin)
    );
  }

  // ---- Pricing --------------------------------------------------------------------------
  // The rate depends on the day the booking STARTS (on the lot clock).
  // cfg = { rates: { car: { weekday, weekend }, bike: { ... } }, weekendDays: [0, 6], utcOffsetMinutes }
  function dayTypeFor(startMs, cfg) {
    const dow = lotParts(startMs, cfg.utcOffsetMinutes).dow;
    return cfg.weekendDays.indexOf(dow) !== -1 ? 'weekend' : 'weekday';
  }

  function priceFor(vehicle, startMs, hours, cfg) {
    const dayType = dayTypeFor(startMs, cfg);
    const rate = cfg.rates[vehicle][dayType];
    const rupees = rate * hours;
    return { dayType, rate, rupees, paise: Math.round(rupees * 100) };
  }

  return {
    MIN, HOUR, DAY, LOT, VEHICLES,
    normalizePlate, isValidPlate, formatPlate,
    bayId, parseBay,
    lotParts, lotDateString, startMsFromLot, slotFloor, formatTime, formatDate, formatWindow,
    dayTypeFor, priceFor,
  };
});
