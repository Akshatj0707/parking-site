'use strict';

/*
 * The entry and exit QR codes.
 *
 * Once a booking is paid the customer gets TWO QR codes on their pass page:
 *   IN   the staff scan it when the vehicle comes in. It can be used once.
 *   OUT  the staff scan it when the vehicle leaves. If the vehicle stays past the booked end time (plus a short grace
 *        period) the customer first pays the extra hours, and the exit is complete only after that payment.
 *
 * Only the admin (permission gate:scan) can scan. Scanning needs a signed-in phone or computer; the QR codes themselves
 * hold nothing but a signed reference, so a copy of one is useless without the booking's current state.
 *
 * A QR code is the address /scan?t=<token>. The token is "<kind>.<reference>.<signature>" where kind is in, out or pass.
 * The signature is an HMAC made with the site's secret (see auth.signFor), so nothing secret is stored for each booking and
 * nobody can make a token for another booking. A "pass" token opens the customer's pass page; it is the key to that page.
 *
 * What is added to a booking (all optional):
 *   entryAt, entryBy      when and by whom the vehicle was scanned in
 *   exitScanAt            when the exit QR was scanned
 *   exitAt, exitBy        when the vehicle really left (the exit scan, or the payment of the overstay that followed it)
 *   overstay              { hours, amountPaise, rate, status: due | paid | waived, orderId, paymentId, paidAt, method, ... }
 *
 * The extra charge is: 0 when the vehicle leaves up to the grace period after the booked end, otherwise every started hour
 * times the booking's own hourly rate. It is worked out when the exit QR is scanned and then stays fixed, so the amount the
 * customer is shown is the amount they pay.
 */

const crypto = require('crypto');
const qrcode = require('qrcode-generator');
const S = require('../public/js/shared.js');
const { HttpError } = require('./errors');
const { verifyPaymentSignature } = require('./payments');

const { MIN, HOUR, LOT } = S;

const TOKEN = /^(in|out|pass)\.([A-Z0-9]{6,12})\.([A-Za-z0-9_-]{22})$/;
const SIG_LENGTH = 22; // 22 base64url characters are 132 bits
// Without a webhook, an unpaid overstay order is looked up at Razorpay once a minute for this long.
const RECONCILE_AFTER = 60 * 1000;
const RECONCILE_TRIES = 30;

const rupeesText = (paise) => '₹' + (paise % 100 ? (paise / 100).toFixed(2) : String(paise / 100));
const ratePerHour = (b) => Number(b.rate) > 0 ? Number(b.rate) : b.hours > 0 ? b.amountPaise / 100 / b.hours : 0;

function providerError(err) {
  if (err && typeof err.error === 'object' && err.error) {
    return [err.statusCode, err.error.code, err.error.description].filter(Boolean).join(' ').slice(0, 300);
  }
  return String((err && err.message) || err).slice(0, 300);
}

// ---- Pure helpers (used by bookings.js to describe a booking) --------------------------------------------------

// How much a vehicle owes for staying until `at`. Hours are counted per started hour after the booked end, and nothing is
// owed while the vehicle is within the grace period.
function overstayFor(b, at, gateConfig) {
  const late = at - b.endMs;
  if (late <= gateConfig.graceMinutes * MIN) return { hours: 0, amountPaise: 0, overMinutes: Math.max(0, Math.ceil(late / MIN)) };
  const hours = Math.ceil(late / HOUR);
  return { hours, amountPaise: Math.round(hours * ratePerHour(b) * 100), overMinutes: Math.ceil(late / MIN) };
}

// Where a booking is in its visit:
//   void          not paid, cancelled or refunded: no QR code works
//   upcoming      the entry QR does not work yet
//   ready         the entry QR works now
//   inside        scanned in, inside the booked time (or the grace period)
//   overstaying   scanned in, past the booked end and the grace period
//   payment_due   the exit QR was scanned and an extra charge must be paid before the vehicle leaves
//   left          scanned out (and paid, if there was a charge)
//   unused        the booked time ended and the vehicle never came in
function stageOf(b, now, gateConfig) {
  if (b.status !== 'paid') return 'void';
  if (b.exitAt) return 'left';
  if (b.exitScanAt && b.overstay && b.overstay.status === 'due') return 'payment_due';
  if (b.entryAt) return now - b.endMs > gateConfig.graceMinutes * MIN ? 'overstaying' : 'inside';
  if (now >= b.endMs) return 'unused';
  if (now >= b.startMs - gateConfig.earlyMinutes * MIN) return 'ready';
  return 'upcoming';
}

// The gate part of a booking, for the staff pages and the customer's pass. No payment ids.
function gateState(b, now, gateConfig) {
  const stage = stageOf(b, now, gateConfig);
  let estimate = null;
  if (stage === 'overstaying') {
    const e = overstayFor(b, now, gateConfig);
    estimate = { hours: e.hours, amount: e.amountPaise / 100, overMinutes: e.overMinutes };
  }
  const ov = b.overstay || null;
  return {
    stage,
    entryAt: b.entryAt || null,
    entryBy: b.entryBy || null,
    exitScanAt: b.exitScanAt || null,
    exitAt: b.exitAt || null,
    exitBy: b.exitBy || null,
    estimate,
    overstay: ov ? { hours: ov.hours, amount: ov.amountPaise / 100, rate: ov.rate, status: ov.status, method: ov.method || null, paidAt: ov.paidAt || null } : null,
  };
}

// The QR code as an SVG picture: one path, so it stays small and sharp at any size.
function qrSvg(text, label) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // the empty border a scanner needs
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c += 1;
        continue;
      }
      let end = c;
      while (end < n && qr.isDark(r, end)) end += 1;
      d += `M${c + quiet} ${r + quiet}h${end - c}v1h-${end - c}z`;
      c = end;
    }
  }
  const size = n + quiet * 2;
  const safe = String(label || 'QR code').replace(/[^\w .:-]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// A scanner gives either the bare token or the whole address that is inside the QR code.
function extractToken(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().slice(0, 600);
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).searchParams.get('t') || '';
    } catch (err) {
      return '';
    }
  }
  return text;
}

class Gate {
  constructor({ config, bookings, razorpay = null, now = Date.now, log = console, signFor }) {
    this.config = config;
    this.gateConfig = config.gate;
    this.bookings = bookings;
    this.store = bookings.store;
    this.razorpay = razorpay;
    this.now = now;
    this.log = log;
    this.signFor = signFor;
    this.starting = new Map(); // booking id -> the Razorpay order that is being created for its overstay
  }

  // ---- Tokens -------------------------------------------------------------------------------------------------
  tokenFor(kind, b) {
    return `${kind}.${b.ref}.${this.signFor('gate', `${kind}|${b.ref}|${b.id}`).slice(0, SIG_LENGTH)}`;
  }

  passPath(b) {
    return '/pass?t=' + this.tokenFor('pass', b);
  }

  // The booking a token belongs to, or a 400. `kinds` says which kinds of token are acceptable here.
  parse(token, kinds) {
    const m = typeof token === 'string' ? TOKEN.exec(token.trim()) : null;
    const bad = new HttpError(400, 'bad_token', 'This QR code is not valid. Ask the customer to open their pass again.');
    if (!m || !kinds.includes(m[1])) throw bad;
    const booking = this.store.bookings.find((b) => b.ref === m[2]);
    if (!booking) throw bad;
    const want = Buffer.from(this.tokenFor(m[1], booking));
    const given = Buffer.from(m[0]);
    if (want.length !== given.length || !crypto.timingSafeEqual(want, given)) throw bad;
    return { kind: m[1], booking };
  }

  // ---- What a screen shows ------------------------------------------------------------------------------------
  summary(b) {
    return {
      ref: b.ref,
      vehicleLabel: LOT[b.vehicle].label,
      plate: S.formatPlate(b.plate),
      bay: b.bay,
      zone: LOT[b.vehicle].zones[S.parseBay(b.bay).zone],
      startMs: b.startMs,
      endMs: b.endMs,
      hours: b.hours,
      rate: ratePerHour(b),
      window: S.formatWindow(b.startMs, b.endMs, this.config.utcOffsetMinutes),
    };
  }

  state(b, now = this.now()) {
    return gateState(b, now, this.gateConfig);
  }

  clock(ms) {
    return S.formatTime(ms, this.config.utcOffsetMinutes);
  }

  // The staff member who did something, for the record. The operator who signs in with HTTP Basic has no name.
  who(actor) {
    return (actor && (actor.name || actor.email)) || 'Operator';
  }

  reply(tone, outcome, title, message, b, now) {
    return { ok: tone !== 'bad', tone, outcome, title, message, booking: this.summary(b), gate: this.state(b, now) };
  }

  // ---- The customer's pass ------------------------------------------------------------------------------------
  passInfo(token) {
    const { booking: b } = this.parse(token, ['pass']);
    const now = this.now();
    const gate = this.state(b, now);
    const live = gate.stage !== 'void';
    const mode = this.bookings.paymentMode;
    return {
      serverTime: now,
      utcOffsetMinutes: this.config.utcOffsetMinutes,
      booking: this.summary(b),
      gate,
      rules: { earlyMinutes: this.gateConfig.earlyMinutes, graceMinutes: this.gateConfig.graceMinutes },
      qr: live ? { in: `/api/pass/qr?t=${encodeURIComponent(token)}&k=in`, out: `/api/pass/qr?t=${encodeURIComponent(token)}&k=out` } : null,
      payments: { mode, keyId: mode === 'razorpay' ? this.config.razorpay.keyId : null },
      siteName: this.config.siteName,
    };
  }

  // The QR code picture. `origin` is the address of the website, which goes in front of /scan.
  qrFor(token, kind, origin) {
    if (kind !== 'in' && kind !== 'out') throw new HttpError(400, 'bad_kind', 'The QR code must be in or out.');
    const { booking } = this.parse(token, ['pass']);
    if (booking.status !== 'paid') throw new HttpError(404, 'not_found', 'This booking has no QR codes.');
    const url = `${origin}/scan?t=${this.tokenFor(kind, booking)}`;
    return qrSvg(url, kind === 'in' ? 'Entry QR code' : 'Exit QR code');
  }

  // ---- Scanning (admin) ---------------------------------------------------------------------------------------
  // input: { token } (what the QR code holds), or { ref | plate, action: 'in' | 'out' } typed by the staff member.
  async scan(input, actor) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    let booking = null;
    let action = null;
    if (typeof body.token === 'string' && body.token.trim() !== '') {
      const parsed = this.parse(extractToken(body.token), ['in', 'out']);
      booking = parsed.booking;
      action = parsed.kind;
    } else if (body.action === 'in' || body.action === 'out') {
      action = body.action;
      booking = this.findTyped(body, action);
    } else {
      throw new HttpError(400, 'invalid_scan', 'Scan a QR code, or type a booking reference or vehicle number and choose Entry or Exit.');
    }
    return action === 'in' ? this.enter(booking, actor) : this.leave(booking, actor);
  }

  // For a customer whose phone is flat: the staff member types the reference or the vehicle number.
  findTyped(body, action) {
    const now = this.now();
    const all = this.store.bookings;
    if (typeof body.ref === 'string' && body.ref.trim() !== '') {
      const ref = body.ref.trim().toUpperCase();
      const found = /^[A-Z0-9]{6,12}$/.test(ref) ? all.find((b) => b.ref === ref) : null;
      if (!found) throw new HttpError(404, 'unknown_booking', 'We could not find a booking with that reference.');
      return found;
    }
    const plate = S.normalizePlate(body.plate);
    if (!S.isValidPlate(plate)) throw new HttpError(400, 'invalid_plate', 'Enter a booking reference or a valid vehicle number, for example MP 09 AB 1234.');
    const mine = all.filter((b) => b.status === 'paid' && b.plate === plate);
    const early = this.gateConfig.earlyMinutes * MIN;
    const pick =
      action === 'out'
        ? mine.find((b) => b.entryAt && !b.exitAt)
        : mine.find((b) => !b.entryAt && b.startMs - early <= now && now < b.endMs) || mine.find((b) => !b.entryAt && b.endMs > now);
    if (!pick) throw new HttpError(404, 'unknown_booking', `There is no paid booking for ${S.formatPlate(plate)} that can be scanned ${action === 'in' ? 'in' : 'out'} now.`);
    return pick;
  }

  // Nothing waits between the checks and the change, so two quick scans of the same QR code cannot both get in.
  async enter(b, actor) {
    const now = this.now();
    if (b.status !== 'paid') {
      const never = b.status === 'pending' || (b.status === 'cancelled' && b.cancelReason !== 'operator');
      return this.reply('bad', 'not_valid', 'Not a valid booking', never ? 'This booking was never paid. Do not let the vehicle in.' : 'This booking was cancelled or refunded. Do not let the vehicle in.', b, now);
    }
    if (b.exitAt) return this.reply('warn', 'already_left', 'Already left', `This vehicle already left at ${this.clock(b.exitAt)}. This booking cannot be used again.`, b, now);
    if (b.entryAt) {
      return this.reply('warn', 'already_entered', 'Already scanned in', `This QR code was already scanned at ${this.clock(b.entryAt)}${b.entryBy ? ' by ' + b.entryBy : ''}. An entry QR code works only once.`, b, now);
    }
    const opens = b.startMs - this.gateConfig.earlyMinutes * MIN;
    if (now < opens) return this.reply('warn', 'too_early', 'Too early', `Entry opens at ${this.clock(opens)}. The booking starts at ${this.clock(b.startMs)}.`, b, now);
    if (now >= b.endMs) {
      return this.reply('bad', 'expired', 'Booking time is over', `The booked time ended at ${this.clock(b.endMs)} and this vehicle was never scanned in. It cannot enter on this booking.`, b, now);
    }
    b.entryAt = now;
    b.entryBy = this.who(actor);
    await this.bookings.persistNow();
    this.log.info(`Booking ${b.ref} (${b.plate}) entered bay ${b.bay}, scanned by ${b.entryBy}.`);
    return this.reply('ok', 'entered', 'Entry recorded', `Send it to bay ${b.bay} (${LOT[b.vehicle].zones[S.parseBay(b.bay).zone]}). Booked until ${this.clock(b.endMs)}.`, b, now);
  }

  async leave(b, actor) {
    const now = this.now();
    if (b.status !== 'paid') {
      return this.reply('bad', 'not_valid', 'Not a valid booking', 'This booking was cancelled, refunded or never paid.', b, now);
    }
    if (b.exitAt) return this.reply('warn', 'already_left', 'Already left', `This vehicle already left at ${this.clock(b.exitAt)}.`, b, now);
    if (!b.entryAt) {
      return this.reply('bad', 'not_entered', 'Never scanned in', 'This vehicle was never scanned in at the entrance, so there is nothing to scan out. Check the booking with the customer.', b, now);
    }
    const ov = b.overstay;
    if (b.exitScanAt && ov && ov.status === 'due') return this.due(b, now, true);

    const extra = overstayFor(b, now, this.gateConfig);
    b.exitScanAt = now;
    b.exitBy = this.who(actor);
    if (extra.hours === 0) {
      b.exitAt = now;
      await this.bookings.persistNow();
      this.log.info(`Booking ${b.ref} (${b.plate}) left, scanned by ${b.exitBy}.`);
      const late = extra.overMinutes > 0 ? ` It left ${extra.overMinutes} min after the booked end, which is inside the free ${this.gateConfig.graceMinutes} minutes.` : '';
      return this.reply('ok', 'exited', 'Exit recorded', `Nothing extra to pay. Let the vehicle go.${late}`, b, now);
    }
    b.overstay = { hours: extra.hours, overMinutes: extra.overMinutes, rate: ratePerHour(b), amountPaise: extra.amountPaise, status: 'due', computedAt: now };
    await this.bookings.persistNow();
    this.log.warn(`Booking ${b.ref} (${b.plate}) is ${extra.overMinutes} min over: ${rupeesText(extra.amountPaise)} is due before it leaves.`);
    return this.due(b, now, false);
  }

  due(b, now, again) {
    const ov = b.overstay;
    const text = `${ov.overMinutes} min past the booked end: ${ov.hours} extra ${ov.hours === 1 ? 'hour' : 'hours'} at ${rupeesText(Math.round(ov.rate * 100))} an hour is ${rupeesText(ov.amountPaise)}.`;
    return this.reply('warn', 'payment_due', `Extra ${rupeesText(ov.amountPaise)} to pay`, `${text} The customer pays on their phone (their pass page). Let the vehicle go only when this turns to paid.${again ? ' This exit QR was already scanned.' : ''}`, b, now);
  }

  // What the scanner screen asks every few seconds while it waits for a payment.
  status(ref) {
    const clean = String(ref || '').trim().toUpperCase();
    const b = /^[A-Z0-9]{6,12}$/.test(clean) ? this.store.bookings.find((x) => x.ref === clean) : null;
    if (!b) throw new HttpError(404, 'unknown_booking', 'We could not find a booking with that reference.');
    return { booking: this.summary(b), gate: this.state(b), serverTime: this.now() };
  }

  // Vehicles that are inside right now.
  inside() {
    const now = this.now();
    const rows = this.store.bookings
      .filter((b) => b.status === 'paid' && b.entryAt && !b.exitAt)
      .sort((a, b) => a.entryAt - b.entryAt)
      .map((b) => ({ booking: this.summary(b), gate: this.state(b, now) }));
    return { serverTime: now, count: rows.length, vehicles: rows };
  }

  // The admin settles an overstay in another way: the customer paid cash at the gate (method "manual"), or the charge is
  // dropped ("waive"). Either way the vehicle is then free to go.
  async settleManually(ref, method, actor) {
    const clean = String(ref || '').trim().toUpperCase();
    const b = /^[A-Z0-9]{6,12}$/.test(clean) ? this.store.bookings.find((x) => x.ref === clean) : null;
    if (!b) throw new HttpError(404, 'unknown_booking', 'We could not find a booking with that reference.');
    if (method !== 'manual' && method !== 'waive') throw new HttpError(400, 'invalid_method', 'Choose "collected" or "waive".');
    const ov = b.overstay;
    if (b.status !== 'paid' || !ov || ov.status !== 'due' || b.exitAt) throw new HttpError(409, 'nothing_due', 'This booking has no extra charge waiting to be paid.');
    const now = this.now();
    if (ov.orderId && method === 'waive') this.log.warn(`Booking ${b.ref}: the extra charge was waived although a Razorpay order (${ov.orderId}) was started. If the customer paid it, refund it.`);
    ov.status = method === 'waive' ? 'waived' : 'paid';
    ov.method = method === 'waive' ? 'waived' : 'manual';
    ov.paidAt = now;
    ov.settledBy = this.who(actor);
    b.exitAt = b.exitScanAt || now;
    await this.bookings.persistNow();
    this.log.warn(`Booking ${b.ref}: the extra ${rupeesText(ov.amountPaise)} was ${method === 'waive' ? 'waived' : 'collected another way'} by ${ov.settledBy}.`);
    return this.reply('ok', method === 'waive' ? 'waived' : 'collected', method === 'waive' ? 'Charge waived' : 'Marked as collected', 'The vehicle can go.', b, now);
  }

  // ---- Paying an overstay (customer) --------------------------------------------------------------------------
  dueBooking(token) {
    const { booking: b } = this.parse(token, ['pass']);
    const ov = b.overstay;
    if (b.status !== 'paid' || !ov || ov.status !== 'due' || b.exitAt) throw new HttpError(409, 'nothing_due', 'There is no extra charge to pay on this booking.');
    return b;
  }

  async startOverstay(token) {
    const b = this.dueBooking(token);
    const mode = this.bookings.paymentMode;
    const ov = b.overstay;
    if (mode === 'unavailable') throw new HttpError(503, 'payments_unavailable', 'Online payment is switched off for now. Please pay the staff at the gate.');
    if (mode === 'demo') return { payment: { mode: 'demo', amount: ov.amountPaise, currency: 'INR' }, booking: this.summary(b), gate: this.state(b) };
    const view = () => ({
      payment: { mode: 'razorpay', keyId: this.config.razorpay.keyId, orderId: ov.orderId, amount: ov.amountPaise, currency: 'INR', name: this.config.siteName, description: `Extra parking time, bay ${b.bay}` },
      booking: this.summary(b),
      gate: this.state(b),
    });
    if (ov.orderId) return view(); // an earlier attempt is reused: Razorpay lets the same order be paid again after a failure
    if (!this.starting.has(b.id)) {
      const job = this.createOrder(b).then(view);
      const clear = () => this.starting.delete(b.id);
      job.then(clear, clear);
      this.starting.set(b.id, job);
    }
    return this.starting.get(b.id);
  }

  async createOrder(b) {
    const ov = b.overstay;
    let order;
    try {
      order = await this.razorpay.orders.create({
        amount: ov.amountPaise,
        currency: 'INR',
        receipt: 'ov_' + b.id, // at most 40 characters
        notes: { booking_ref: b.ref, kind: 'overstay', overstay_hours: String(ov.hours), vehicle_number: b.plate },
      });
      if (!order || typeof order.id !== 'string') throw new Error('Razorpay did not return an order id.');
    } catch (err) {
      this.log.error(`Razorpay could not create the order for the extra time of booking ${b.ref}: ${providerError(err)}`);
      throw new HttpError(502, 'payment_provider_error', 'We could not start the payment. Please try again in a moment.');
    }
    ov.orderId = order.id;
    ov.orderAt = this.now();
    await this.bookings.persistNow(); // saved before the customer sees the payment window, so a late payment can find its booking
  }

  // The customer's browser says "payment done". Only the signature proves it.
  async verifyOverstay(body) {
    if (this.bookings.paymentMode !== 'razorpay') throw new HttpError(404, 'not_found', 'Not found.');
    const data = body && typeof body === 'object' ? body : {};
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = data;
    if ([orderId, paymentId, signature, data.t].some((v) => typeof v !== 'string' || v === '' || v.length > 200)) {
      throw new HttpError(400, 'invalid_payment', 'The payment details were incomplete.');
    }
    if (!verifyPaymentSignature(this.config.razorpay.keySecret, orderId, paymentId, signature)) {
      this.log.warn('A payment confirmation for extra parking time failed the signature check and was ignored.');
      throw new HttpError(400, 'bad_signature', 'We could not verify this payment. If money was taken from your account, please contact us with your payment ID.');
    }
    const { booking: b } = this.parse(data.t, ['pass']);
    if (!b.overstay || b.overstay.orderId !== orderId) {
      this.log.error(`Payment ${paymentId} was verified for order ${orderId}, but booking ${b.ref} has no extra charge with that order. Check the Razorpay dashboard.`);
      throw new HttpError(400, 'wrong_order', `We could not match this payment to the extra charge. Please contact us with payment ID ${paymentId}.`);
    }
    return this.settle(b, paymentId);
  }

  // Demo mode (a developer's own computer, no Razorpay keys): the pretend "Pay" button.
  async confirmDemo(token) {
    if (this.bookings.paymentMode !== 'demo') throw new HttpError(404, 'not_found', 'Not found.');
    const b = this.dueBooking(token);
    return this.settle(b, 'demo_' + crypto.randomBytes(6).toString('hex'));
  }

  // A verified payment for the extra charge exists. Safe to call twice for the same payment (browser, webhook, check).
  async settle(b, paymentId) {
    const ov = b.overstay;
    if (ov.status === 'paid' || ov.status === 'waived') {
      if (ov.paymentId && ov.paymentId !== paymentId) {
        this.log.error(`The extra charge of booking ${b.ref} is already settled, but payment ${paymentId} was also captured for it. Refund the extra payment from the Razorpay dashboard.`);
      }
      return { outcome: 'paid', booking: b };
    }
    const now = this.now();
    ov.status = 'paid';
    ov.paymentId = paymentId;
    ov.paidAt = now;
    ov.method = /^demo_/.test(paymentId) ? 'demo' : 'razorpay';
    b.exitAt = b.exitScanAt || now;
    await this.bookings.persistNow();
    this.log.info(`Booking ${b.ref}: the extra ${rupeesText(ov.amountPaise)} was paid (${paymentId}) and the vehicle may leave.`);
    return { outcome: 'paid', booking: b };
  }

  // Razorpay tells us a payment was captured. Returns null when the order is not an extra charge, so the normal booking
  // payment handling goes on.
  async handleWebhook(payment) {
    const b = this.store.bookings.find((x) => x.overstay && x.overstay.orderId === payment.order_id);
    if (!b) return null;
    if (payment.amount !== b.overstay.amountPaise || payment.currency !== 'INR') {
      this.log.error(`Webhook for the extra charge of booking ${b.ref} has amount ${payment.amount} ${payment.currency}, expected ${b.overstay.amountPaise} INR. Ignored.`);
      return { ignored: 'amount_mismatch' };
    }
    await this.settle(b, payment.id);
    return { outcome: 'overstay_paid' };
  }

  // Safety net that needs no webhook: ask Razorpay once a minute whether an unpaid extra-charge order was paid.
  async reconcile() {
    if (!this.razorpay) return 0;
    const now = this.now();
    const due = this.store.bookings.filter((b) => b.overstay && b.overstay.status === 'due' && b.overstay.orderId && !b.exitAt && now >= (b.overstay.orderAt || 0) + RECONCILE_AFTER && (b.overstay.checks || 0) < RECONCILE_TRIES);
    let found = 0;
    for (const b of due) {
      const ov = b.overstay;
      ov.checks = (ov.checks || 0) + 1;
      let list;
      try {
        list = await this.razorpay.orders.fetchPayments(ov.orderId);
      } catch (err) {
        this.log.error(`Could not ask Razorpay about the extra charge order ${ov.orderId}: ${providerError(err)}`);
        continue;
      }
      const captured = ((list && list.items) || []).find((p) => p && p.status === 'captured' && p.amount === ov.amountPaise && p.currency === 'INR');
      if (captured) {
        found += 1;
        this.log.warn(`Booking ${b.ref} had a payment for extra time that was never confirmed (${captured.id}). Settling it now.`);
        await this.settle(b, captured.id);
      }
    }
    if (due.length) this.bookings.persist();
    return found;
  }
}

function createGate(deps) {
  return new Gate(deps);
}

module.exports = { createGate, Gate, gateState, stageOf, overstayFor, qrSvg, extractToken };
