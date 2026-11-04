'use strict';

/*
 * Everything about bookings lives here: checking a request, holding a bay while the customer pays,
 * confirming the payment, refunding when a payment arrives too late, and lookups for the website.
 *
 * A booking moves through these statuses:
 *   pending         held for a few minutes while the customer pays; blocks the bay only until holdUntil
 *   paid            confirmed; blocks the bay for its time window
 *   cancelled       released by the customer, replaced by a newer attempt, or never paid
 *                   (on a developer's computer, with simulated payments, also a paid booking that the admin cancelled: cancelReason "operator")
 *   refund_pending  a refund is being sent: the payment arrived but the bay was no longer free, or the operator
 *                   cancelled a paid booking (cancelReason "operator")
 *   refunded        that refund was accepted by Razorpay
 *   refund_failed   the refund did not work, or the server stopped while it was being sent (refundInterrupted);
 *                   the operator can try again from the dashboard, or refund it by hand
 *
 * The operator can cancel a paid booking that has not ended yet (operatorCancel). That frees the bay at once and
 * sends the full amount back through Razorpay.
 */

const crypto = require('crypto');
const S = require('../public/js/shared.js');
const { HttpError } = require('./errors');
const { verifyPaymentSignature } = require('./payments');
const { analytics, overview, sampleBookings } = require('./analytics');

const { MIN, HOUR, DAY, LOT, VEHICLES } = S;

// A booking reference is easy to read out loud: it has no I, L, O, 0 or 1.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// If a customer paid but the confirmation never reached us, we ask Razorpay about the order this long after the hold ended.
const RECONCILE_AFTER = 60 * 1000;
const RECONCILE_TRIES = 5;

const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;

function money(paise) {
  return '₹' + (paise % 100 ? (paise / 100).toFixed(2) : String(paise / 100));
}

// The Razorpay library rejects with plain objects like { statusCode, error: { code, description } }.
function providerError(err) {
  if (err && typeof err.error === 'object' && err.error) {
    return [err.statusCode, err.error.code, err.error.description].filter(Boolean).join(' ').slice(0, 300);
  }
  return String((err && err.message) || err).slice(0, 300);
}

class BookingService {
  constructor({ config, store, razorpay = null, now = Date.now, log = console }) {
    if (config.razorpay.configured && !razorpay) throw new Error('Razorpay keys are set but no Razorpay client was given.');
    this.config = config;
    this.store = store;
    this.razorpay = razorpay;
    this.now = now;
    this.log = log;
    this.reconciling = false;
  }

  // razorpay    keys are set: the real Razorpay checkout (test keys give Razorpay's test window, live keys take real money)
  // demo        ONLY on a developer's own computer (not production, no keys): payment is simulated so the pages can be tried
  // unavailable booking is switched off rather than pretending to take money: a production site with no Razorpay keys, or
  //             live keys on storage that is wiped at every restart (real payments would be taken and the bookings lost)
  get paymentMode() {
    if (this.config.razorpay.configured) return this.config.unsafeLiveStorage ? 'unavailable' : 'razorpay';
    return this.config.production ? 'unavailable' : 'demo';
  }

  // Why booking is off, for the owner: 'no_keys', 'temporary_storage' or null.
  get unavailableReason() {
    if (this.paymentMode !== 'unavailable') return null;
    return this.config.razorpay.configured ? 'temporary_storage' : 'no_keys';
  }

  // The payment connection, in plain words, for the owner's pages. Nothing secret is in it.
  paymentStatus() {
    const cfg = this.config;
    const mode = this.paymentMode;
    const persistent = cfg.dataOnRenderDisk !== false;
    const problems = [];
    if (mode === 'unavailable' && this.unavailableReason === 'no_keys') {
      problems.push({
        level: 'bad',
        text: 'Razorpay is not connected, so customers cannot book or pay. In Render, open this service, choose Environment, add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, then Save and deploy.',
      });
    }
    if (mode === 'unavailable' && this.unavailableReason === 'temporary_storage') {
      problems.push({
        level: 'bad',
        text: 'Live Razorpay keys are set, but this site keeps its bookings on temporary storage that is wiped whenever the site restarts. Booking is switched off so that no customer pays for a booking that could be lost. Move to a Render plan with a disk (render.yaml), or use Razorpay test keys.',
      });
    }
    if (mode === 'razorpay' && !cfg.razorpay.live) {
      problems.push({
        level: 'info',
        text: 'Razorpay test keys are in use. Customers get Razorpay’s real payment window and every payment shows in your Razorpay dashboard under Test Mode, but no real money moves. Replace the keys with live keys (rzp_live_…) once Razorpay has activated your account.',
      });
    }
    if (mode === 'razorpay' && !cfg.razorpay.webhookSecret) {
      problems.push({
        level: 'warn',
        text: 'The Razorpay webhook is not set up (RAZORPAY_WEBHOOK_SECRET). Payments are still checked, but add the webhook so a payment is never missed when a customer closes the page too early.',
      });
    }
    if (!persistent && mode !== 'demo') {
      problems.push({
        level: 'warn',
        text: 'Bookings and customer accounts are stored on temporary storage: they are lost whenever the site sleeps, restarts or is updated. A real business needs a Render plan with a disk (render.yaml).',
      });
    }
    return {
      mode,
      reason: this.unavailableReason,
      keysSet: cfg.razorpay.configured,
      live: cfg.razorpay.configured && cfg.razorpay.live,
      webhookSet: Boolean(cfg.razorpay.webhookSecret),
      storageKept: persistent,
      acceptingPayments: mode === 'razorpay',
      problems,
    };
  }

  // Writing to disk can fail (disk full, folder locked). After a payment the in-memory state is still the truth,
  // so we shout about it instead of telling the customer their paid booking failed.
  persist() {
    try {
      this.store.save();
    } catch (err) {
      this.log.error(`COULD NOT SAVE bookings: ${err.message}. Bookings are kept in memory until a save works. Fix the problem (disk full? folder not writable?) and do not restart the server yet.`);
    }
  }

  // Call once when the server starts. Nothing can be in flight then, so a booking still marked "refund_pending" was cut
  // off by a restart: nobody knows whether Razorpay got the request. It becomes a failed refund, which the operator
  // can retry from the dashboard. A retry is safe: Razorpay refuses a second full refund of the same payment, and when
  // it does, operatorCancel() checks with Razorpay and marks the booking refunded instead of sending anything again.
  recoverInterruptedRefunds() {
    let count = 0;
    for (const b of this.store.bookings) {
      if (b.status !== 'refund_pending') continue;
      b.status = 'refund_failed';
      b.refundError = null;
      b.refundInterrupted = true;
      count += 1;
    }
    if (count) this.persist();
    return count;
  }

  isBlocking(b, now) {
    return b.status === 'paid' || (b.status === 'pending' && b.holdUntil > now);
  }

  // ---- Checking a request ---------------------------------------------------------------

  parseWindow(input, now) {
    const cfg = this.config;
    const vehicle = input.vehicle;
    if (!VEHICLES.includes(vehicle)) throw new HttpError(400, 'invalid_vehicle', 'Choose 4-wheeler or 2-wheeler.');

    const hours = Number(input.hours);
    if (!cfg.hoursOptions.includes(hours)) {
      throw new HttpError(400, 'invalid_hours', `Choose ${cfg.hoursOptions[0]} to ${cfg.hoursOptions[cfg.hoursOptions.length - 1]} hours.`);
    }

    const startMs = S.startMsFromLot(input.date, input.time, cfg.utcOffsetMinutes);
    if (!Number.isFinite(startMs) || S.lotDateString(startMs, cfg.utcOffsetMinutes) !== input.date) {
      throw new HttpError(400, 'invalid_time', 'Choose a start date and time.');
    }
    if (S.slotFloor(startMs, cfg.utcOffsetMinutes, cfg.slotMinutes) !== startMs) {
      throw new HttpError(400, 'invalid_time', 'Start on the hour or the half hour.');
    }
    if (startMs < now - cfg.startGraceMinutes * MIN) {
      throw new HttpError(400, 'too_early', 'That start time has already passed. Choose a later time.');
    }
    if (startMs > now + cfg.maxAdvanceDays * DAY) {
      throw new HttpError(400, 'too_late', `You can book up to ${cfg.maxAdvanceDays} days ahead.`);
    }
    return { vehicle, hours, startMs, endMs: startMs + hours * HOUR };
  }

  // Bays of one vehicle type that are unavailable at any point in [startMs, endMs).
  takenBays(vehicle, startMs, endMs, now, skip) {
    const taken = new Set();
    for (const b of this.store.bookings) {
      if (b.vehicle !== vehicle || !this.isBlocking(b, now) || (skip && skip(b))) continue;
      if (b.startMs < endMs && startMs < b.endMs) taken.add(b.bay);
    }
    return taken;
  }

  // A paid or held booking that clashes with `c`: same vehicle number (kind "plate") or same bay (kind "bay").
  findConflict(c, now) {
    let bayConflict = null;
    for (const b of this.store.bookings) {
      if (b.id === c.id || !this.isBlocking(b, now) || !overlaps(b, c)) continue;
      if (b.plate === c.plate) return { kind: 'plate', booking: b };
      if (b.bay === c.bay) bayConflict = { kind: 'bay', booking: b };
    }
    return bayConflict;
  }

  // ---- What the booking page asks for -----------------------------------------------------

  availability(query) {
    const now = this.now();
    const w = this.parseWindow(query && typeof query === 'object' ? query : {}, now);
    const lot = LOT[w.vehicle];
    const taken = this.takenBays(w.vehicle, w.startMs, w.endMs, now);
    const price = S.priceFor(w.vehicle, w.startMs, w.hours, this.config);
    const zones = lot.zones.map((name, i) => {
      let used = 0;
      for (let n = i * lot.perZone + 1; n <= (i + 1) * lot.perZone; n++) if (taken.has(S.bayId(w.vehicle, n))) used += 1;
      return { name, total: lot.perZone, free: lot.perZone - used };
    });
    return {
      vehicle: w.vehicle,
      startMs: w.startMs,
      endMs: w.endMs,
      hours: w.hours,
      window: S.formatWindow(w.startMs, w.endMs, this.config.utcOffsetMinutes),
      dayType: price.dayType,
      rate: price.rate,
      amount: price.rupees,
      total: lot.total,
      free: lot.total - taken.size,
      zones,
      taken: [...taken].sort(),
    };
  }

  // ---- Holding a bay and starting the payment ----------------------------------------------

  newRef() {
    for (;;) {
      let ref = '';
      for (let i = 0; i < 8; i++) ref += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
      if (!this.store.bookings.some((b) => b.ref === ref)) return ref;
    }
  }

  // Checks the request and, if the bay is free, records an unpaid booking that holds it for a few minutes.
  // This runs start to finish without waiting on anything, so two visitors can never get the same bay.
  hold(input) {
    const now = this.now();
    const cfg = this.config;
    const body = input && typeof input === 'object' ? input : {};
    const w = this.parseWindow(body, now);

    const plate = S.normalizePlate(body.plate);
    if (!S.isValidPlate(plate)) throw new HttpError(400, 'invalid_plate', 'Enter a valid vehicle number, for example MP 09 AB 1234.');

    const lot = LOT[w.vehicle];
    let bay = null;
    let zone = null;
    const rawBay = body.bay;
    if (rawBay !== undefined && rawBay !== null && rawBay !== '' && rawBay !== 'auto') {
      const parsed = S.parseBay(String(rawBay).toUpperCase());
      if (!parsed || parsed.vehicle !== w.vehicle) throw new HttpError(400, 'invalid_bay', 'That bay does not exist.');
      bay = S.bayId(w.vehicle, parsed.n);
    } else {
      zone = typeof body.zone === 'string' && body.zone.trim() !== '' ? Number(body.zone) : body.zone;
      if (!Number.isInteger(zone) || zone < 0 || zone >= lot.zones.length) throw new HttpError(400, 'invalid_zone', 'Choose a zone.');
    }

    // A vehicle can only be in one place at a time.
    if (this.store.bookings.some((b) => b.status === 'paid' && b.plate === plate && overlaps(b, w))) {
      throw new HttpError(409, 'plate_busy', 'This vehicle already has a booking that overlaps this time. Use “Find my booking” to see it.');
    }

    // A new attempt for the same vehicle number replaces its own unpaid hold. Paid bookings are never touched.
    const isOwnHold = (b) => b.status === 'pending' && b.plate === plate;
    const taken = this.takenBays(w.vehicle, w.startMs, w.endMs, now, isOwnHold);
    if (bay) {
      if (taken.has(bay)) throw new HttpError(409, 'bay_taken', `Bay ${bay} was just taken for that time. Choose another bay.`);
    } else {
      for (let n = zone * lot.perZone + 1; n <= (zone + 1) * lot.perZone; n++) {
        const id = S.bayId(w.vehicle, n);
        if (!taken.has(id)) {
          bay = id;
          break;
        }
      }
      if (!bay) throw new HttpError(409, 'zone_full', `${lot.zones[zone]} is full for that time. Choose another zone or time.`);
    }

    const price = S.priceFor(w.vehicle, w.startMs, w.hours, cfg);
    const booking = {
      id: 'bk_' + crypto.randomBytes(8).toString('hex'),
      ref: this.newRef(),
      vehicle: w.vehicle,
      bay,
      plate,
      startMs: w.startMs,
      endMs: w.endMs,
      hours: w.hours,
      dayType: price.dayType,
      rate: price.rate,
      amountPaise: price.paise,
      status: 'pending',
      createdAt: now,
      holdUntil: now + cfg.holdMinutes * MIN,
      orderId: null,
      paymentId: null,
      paidAt: null,
      mode: this.paymentMode,
      // the signed-in customer who made it (set by the website, never by the browser), or null
      customerId: typeof body.customerId === 'string' && /^usr_[0-9a-f]{12}$/.test(body.customerId) ? body.customerId : null,
    };

    const replaced = this.store.bookings.filter((b) => isOwnHold(b) && this.isBlocking(b, now) && overlaps(b, booking));
    replaced.forEach((b) => {
      b.status = 'cancelled';
      b.cancelledAt = now;
      b.cancelReason = 'replaced';
    });
    this.store.add(booking);
    try {
      this.store.save();
    } catch (err) {
      this.store.remove(booking.id);
      replaced.forEach((b) => {
        b.status = 'pending';
        delete b.cancelledAt;
        delete b.cancelReason;
      });
      this.log.error(`Could not save a new booking: ${err.message}`);
      throw new HttpError(500, 'storage_error', 'We could not save your booking. Please try again.');
    }
    return booking;
  }

  discard(id) {
    this.store.remove(id);
    this.persist();
  }

  // Customer closed the payment window without paying: free the bay straight away.
  release(id) {
    const b = this.store.get(id);
    if (b && b.status === 'pending') {
      b.status = 'cancelled';
      b.cancelledAt = this.now();
      b.cancelReason = 'released';
      this.persist();
    }
  }

  async startCheckout(input) {
    const mode = this.paymentMode;
    if (mode === 'unavailable') {
      throw new HttpError(503, 'payments_unavailable', 'Online booking is switched off for now. Please check back soon.');
    }
    const booking = this.hold(input);
    const amount = booking.amountPaise;

    if (mode === 'demo') {
      return { booking: this.view(booking), payment: { mode: 'demo', amount, currency: 'INR' } };
    }

    let order;
    try {
      order = await this.razorpay.orders.create({
        amount,
        currency: 'INR',
        receipt: booking.id, // at most 40 characters
        notes: { booking_ref: booking.ref, bay: booking.bay, vehicle_number: booking.plate },
      });
      if (!order || typeof order.id !== 'string') throw new Error('Razorpay did not return an order id.');
    } catch (err) {
      this.discard(booking.id);
      this.log.error(`Razorpay could not create an order: ${providerError(err)}. If this says "Authentication failed", check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.`);
      throw new HttpError(502, 'payment_provider_error', 'We could not start the payment. Please try again in a moment.');
    }

    // While we waited for Razorpay the customer may have double-clicked and replaced this hold.
    const current = this.store.get(booking.id);
    if (!current || current.status !== 'pending') {
      throw new HttpError(409, 'hold_lost', 'Your hold on this bay was replaced by a newer attempt. Please try again.');
    }
    current.orderId = order.id;
    this.persist();
    return {
      booking: this.view(current),
      payment: { mode: 'razorpay', keyId: this.config.razorpay.keyId, orderId: order.id, amount, currency: 'INR', name: this.config.siteName },
    };
  }

  // ---- Confirming a payment -----------------------------------------------------------------

  // The customer's browser says "payment done". We trust only the signature, which proves Razorpay produced it.
  async confirmCheckout(body) {
    if (this.paymentMode !== 'razorpay') throw new HttpError(404, 'not_found', 'Not found.');
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body && typeof body === 'object' ? body : {};
    if ([orderId, paymentId, signature].some((v) => typeof v !== 'string' || v === '' || v.length > 100)) {
      throw new HttpError(400, 'invalid_payment', 'The payment details were incomplete.');
    }
    if (!verifyPaymentSignature(this.config.razorpay.keySecret, orderId, paymentId, signature)) {
      this.log.warn('A payment confirmation failed the signature check and was ignored.');
      throw new HttpError(400, 'bad_signature', 'We could not verify this payment. If money was taken from your account, please contact us with your payment ID.');
    }
    const booking = this.store.byOrderId(orderId);
    if (!booking) {
      this.log.error(`Payment ${paymentId} was verified for order ${orderId}, but no booking has that order. Check the Razorpay dashboard and refund it if needed.`);
      throw new HttpError(404, 'unknown_order', `We could not match this payment to a booking. Please contact us with payment ID ${paymentId}.`);
    }
    return this.settle(booking, paymentId);
  }

  // Demo mode: the "Pay" button on the fake payment step.
  async confirmDemo(id) {
    if (this.paymentMode !== 'demo') throw new HttpError(404, 'not_found', 'Not found.');
    const booking = this.store.get(id);
    if (!booking) throw new HttpError(404, 'unknown_booking', 'We could not find this booking. Please start again.');
    if (booking.orderId) throw new HttpError(409, 'not_demo', 'This booking belongs to a real Razorpay payment and cannot be confirmed this way.');
    if (booking.status === 'paid') return { outcome: 'paid', booking };
    return this.settle(booking, 'demo_' + crypto.randomBytes(6).toString('hex'));
  }

  // Razorpay's server tells us a payment was captured. This is the safety net for customers who pay and then close the page.
  async handleWebhook(event) {
    if (!event || (event.event !== 'payment.captured' && event.event !== 'order.paid')) return { ignored: 'event' };
    const p = event.payload && event.payload.payment && event.payload.payment.entity;
    if (!p || typeof p.id !== 'string' || typeof p.order_id !== 'string') return { ignored: 'no_payment' };
    const booking = this.store.byOrderId(p.order_id);
    if (!booking) return { ignored: 'unknown_order' }; // possibly another site that shares this Razorpay account
    if (p.amount !== booking.amountPaise || p.currency !== 'INR') {
      this.log.error(`Webhook for booking ${booking.ref} has amount ${p.amount} ${p.currency}, expected ${booking.amountPaise} INR. Ignored.`);
      return { ignored: 'amount_mismatch' };
    }
    const result = await this.settle(booking, p.id);
    return { outcome: result.outcome };
  }

  // Safety net that needs no webhook: shortly after a hold ends, ask Razorpay once whether the order was paid.
  async reconcile() {
    if (!this.razorpay || this.reconciling) return 0;
    this.reconciling = true;
    let found = 0;
    try {
      const now = this.now();
      const due = this.store.bookings.filter((b) => {
        if (!b.orderId || b.reconciled) return false;
        if (b.status === 'pending') return now >= b.holdUntil + RECONCILE_AFTER;
        if (b.status === 'cancelled') return now >= (b.cancelledAt || b.createdAt) + RECONCILE_AFTER;
        return false;
      });
      for (const b of due) {
        let list;
        try {
          list = await this.razorpay.orders.fetchPayments(b.orderId);
        } catch (err) {
          b.reconcileTries = (b.reconcileTries || 0) + 1;
          if (b.reconcileTries >= RECONCILE_TRIES) b.reconciled = true;
          this.log.error(`Could not ask Razorpay about order ${b.orderId}: ${providerError(err)}`);
          this.persist();
          continue;
        }
        b.reconciled = true;
        const captured = ((list && list.items) || []).find((p) => p && p.status === 'captured' && p.amount === b.amountPaise && p.currency === 'INR');
        if (captured) {
          found += 1;
          this.log.warn(`Booking ${b.ref} had a payment that was never confirmed (${captured.id}). Settling it now.`);
          await this.settle(b, captured.id);
        } else {
          this.persist();
        }
      }
    } finally {
      this.reconciling = false;
    }
    return found;
  }

  // A verified payment exists for `booking`. Confirm it if the bay is still free, otherwise send the money back.
  // Safe to call more than once for the same payment (the browser and the webhook both call it).
  async settle(booking, paymentId) {
    const now = this.now();

    if (booking.status === 'paid') {
      if (booking.paymentId !== paymentId) {
        this.log.error(`Booking ${booking.ref} is already paid with ${booking.paymentId}, but payment ${paymentId} was also captured for it. Refund the extra payment from the Razorpay dashboard.`);
      }
      return { outcome: 'paid', booking };
    }
    if (booking.status === 'refund_pending' || booking.status === 'refunded') return { outcome: booking.status, booking };

    // pending (still held or run out), cancelled, or a refund that failed earlier
    const stillFree = booking.status !== 'refund_failed' && booking.endMs > now && !this.findConflict(booking, now);
    if (stillFree) {
      booking.status = 'paid';
      booking.paymentId = paymentId;
      booking.paidAt = now;
      booking.holdUntil = null;
      this.persist();
      this.log.info(`Booking ${booking.ref} paid: ${booking.plate}, bay ${booking.bay}, ${money(booking.amountPaise)} (${paymentId}).`);
      return { outcome: 'paid', booking };
    }
    return this.refund(booking, paymentId);
  }

  // Sends the whole payment back. Nothing waits before the status changes to refund_pending, so a second request
  // for the same booking sees that a refund is already on its way and cannot start another one.
  async refund(booking, paymentId, { reason = 'Parking time no longer available', byOperator = false } = {}) {
    booking.paymentId = paymentId;
    booking.status = 'refund_pending';
    delete booking.refundInterrupted;
    this.persist();

    if (!this.razorpay) {
      // Demo mode: no money moved, so there is nothing to send back.
      booking.status = 'cancelled';
      booking.cancelledAt = this.now();
      this.persist();
      return { outcome: 'cancelled', booking };
    }
    try {
      const refund = await this.razorpay.payments.refund(paymentId, {
        amount: booking.amountPaise,
        speed: 'normal',
        notes: { booking_ref: booking.ref, reason },
      });
      booking.status = 'refunded';
      booking.refundId = (refund && refund.id) || null;
      booking.refundedAt = this.now();
      booking.refundError = null;
      this.persist();
      if (byOperator) this.log.warn(`Booking ${booking.ref} was cancelled by the operator and payment ${paymentId} (${money(booking.amountPaise)}) was refunded.`);
      else this.log.warn(`Booking ${booking.ref} could not be kept, so payment ${paymentId} (${money(booking.amountPaise)}) was refunded.`);
      return { outcome: 'refunded', booking };
    } catch (err) {
      booking.status = 'refund_failed';
      booking.refundError = providerError(err);
      this.persist();
      this.log.error(`REFUND FAILED for booking ${booking.ref}, payment ${paymentId}: ${booking.refundError}. Try again from the dashboard, or refund it by hand from the Razorpay dashboard.`);
      return { outcome: 'refund_failed', booking };
    }
  }

  // Did Razorpay already send this whole payment back, for example by hand in the Razorpay dashboard, or in a refund
  // whose answer never reached us? Asked only after a refund fails, so a stuck booking can clear itself.
  async alreadyRefunded(paymentId) {
    const payments = this.razorpay && this.razorpay.payments;
    if (!payments || typeof payments.fetch !== 'function') return false;
    try {
      const p = await payments.fetch(paymentId);
      if (!p) return false;
      const refunded = Number(p.amount_refunded) || 0;
      return p.refund_status === 'full' || (refunded > 0 && refunded >= Number(p.amount));
    } catch (err) {
      return false;
    }
  }

  // What to tell a customer whose payment could not become a booking.
  lostMessage({ outcome, booking }) {
    if (outcome === 'refunded' || outcome === 'refund_pending') {
      return `Sorry, that time was taken while your payment was going through. We are refunding ${money(booking.amountPaise)} to your original payment method, which usually takes 5 to 10 working days. Your reference is ${booking.ref}.`;
    }
    if (outcome === 'refund_failed') {
      return `Sorry, that time was taken while your payment was going through, and the automatic refund did not work. Please contact us with payment ID ${booking.paymentId} (reference ${booking.ref}) and we will refund you.`;
    }
    return 'Sorry, that time was taken or the hold ran out. Nothing was charged.';
  }

  // ---- What the website shows -----------------------------------------------------------------

  // For the customer who is booking. Includes the id that the payment step needs.
  view(b) {
    const parsed = S.parseBay(b.bay);
    return {
      id: b.id,
      ref: b.ref,
      vehicle: b.vehicle,
      vehicleLabel: LOT[b.vehicle].label,
      plate: S.formatPlate(b.plate),
      bay: b.bay,
      zone: LOT[b.vehicle].zones[parsed.zone],
      startMs: b.startMs,
      endMs: b.endMs,
      hours: b.hours,
      window: S.formatWindow(b.startMs, b.endMs, this.config.utcOffsetMinutes),
      dayType: b.dayType,
      rate: b.rate,
      amount: b.amountPaise / 100,
      status: b.status,
      holdUntil: b.holdUntil,
    };
  }

  // For anyone who types in a vehicle number: where and when, and nothing about money.
  lookup(input) {
    const plate = S.normalizePlate(input);
    if (!S.isValidPlate(plate)) throw new HttpError(400, 'invalid_plate', 'Enter a valid vehicle number, for example MP 09 AB 1234.');
    const now = this.now();
    const off = this.config.utcOffsetMinutes;
    const list = this.store.bookings
      .filter((b) => b.status === 'paid' && b.plate === plate && b.endMs > now)
      .sort((a, b) => a.startMs - b.startMs)
      .map((b) => ({
        ref: b.ref,
        vehicle: b.vehicle,
        vehicleLabel: LOT[b.vehicle].label,
        plate: S.formatPlate(b.plate),
        bay: b.bay,
        zone: LOT[b.vehicle].zones[S.parseBay(b.bay).zone],
        startMs: b.startMs,
        endMs: b.endMs,
        hours: b.hours,
        window: S.formatWindow(b.startMs, b.endMs, off),
        state: b.startMs <= now ? 'active' : 'upcoming',
      }));
    return { plate: S.formatPlate(plate), bookings: list };
  }

  // ---- The operator cancels a booking ---------------------------------------------------------------

  // A paid booking that has not ended yet can be cancelled. A refund that failed can be tried again.
  canCancel(b, now) {
    return (b.status === 'paid' && b.endMs > now) || b.status === 'refund_failed';
  }

  // One booking as the operator sees it. Unlike the public pages it includes the money details.
  operatorRow(b, now = this.now()) {
    return {
      ref: b.ref,
      vehicle: b.vehicle,
      vehicleLabel: LOT[b.vehicle].label,
      plate: S.formatPlate(b.plate),
      bay: b.bay,
      zone: LOT[b.vehicle].zones[S.parseBay(b.bay).zone],
      startMs: b.startMs,
      endMs: b.endMs,
      hours: b.hours,
      window: S.formatWindow(b.startMs, b.endMs, this.config.utcOffsetMinutes),
      amount: b.amountPaise / 100,
      status: b.status,
      cancelledByOperator: b.cancelReason === 'operator',
      sample: Boolean(b.sample),
      paidAt: b.paidAt,
      paymentId: b.paymentId,
      refundId: b.refundId || null,
      refundError: b.refundError || null,
      refundInterrupted: Boolean(b.refundInterrupted),
      state: b.endMs <= now ? 'ended' : b.startMs <= now ? 'active' : 'upcoming',
      canCancel: this.canCancel(b, now),
    };
  }

  // Bookings of one vehicle number that the operator can do something about: cancel, or try the refund again.
  operatorFind(input) {
    const plate = S.normalizePlate(input);
    if (!S.isValidPlate(plate)) throw new HttpError(400, 'invalid_plate', 'Enter a valid vehicle number, for example MP 09 AB 1234.');
    const now = this.now();
    const list = this.store.bookings
      .filter((b) => b.plate === plate && (this.canCancel(b, now) || b.status === 'refund_pending'))
      .sort((a, b) => a.startMs - b.startMs)
      .map((b) => this.operatorRow(b, now));
    return { plate: S.formatPlate(plate), bookings: list };
  }

  // Cancels a paid booking and sends the full amount back. Also used to try a failed refund again.
  // The bay is free the moment the booking leaves the "paid" status, whether or not Razorpay accepts the refund.
  async operatorCancel(ref) {
    const booking = this.store.bookings.find((b) => b.ref === ref);
    if (!booking) throw new HttpError(404, 'unknown_booking', 'We could not find a booking with that reference.');
    const now = this.now();

    // All the checks come first and nothing waits in between, so two quick presses cannot both start a refund.
    if (booking.status === 'refund_pending') {
      throw new HttpError(409, 'refund_in_progress', 'A refund for this booking is already being sent. Wait a moment, then check the dashboard.');
    }
    if (booking.status === 'refunded') throw new HttpError(409, 'already_refunded', 'This booking was already cancelled and refunded.');
    if (booking.status === 'cancelled' && booking.cancelReason === 'operator') {
      throw new HttpError(409, 'already_cancelled', 'This booking was already cancelled.');
    }
    if (!this.canCancel(booking, now)) {
      throw new HttpError(
        409,
        'not_cancellable',
        booking.status === 'paid'
          ? 'This booking has already ended, so it cannot be cancelled here. If the customer should get their money back, refund the payment from the Razorpay Dashboard.'
          : 'This booking was never paid, so there is nothing to cancel or refund.'
      );
    }

    const byOperator = booking.status === 'paid' || booking.cancelReason === 'operator';
    const demoPayment = booking.mode === 'demo' || /^demo_/.test(String(booking.paymentId || ''));
    if (!demoPayment && !this.razorpay) {
      throw new HttpError(
        409,
        'payments_unavailable',
        'This server has no Razorpay keys right now, so it cannot send a refund. Add the keys and try again, or refund the payment from the Razorpay Dashboard.'
      );
    }

    if (byOperator && booking.status === 'paid') {
      booking.cancelledAt = now;
      booking.cancelReason = 'operator';
    }

    if (demoPayment) {
      // A pretend payment: no money moved, so there is nothing to send back.
      booking.status = 'cancelled';
      this.persist();
      this.log.warn(`Booking ${booking.ref} (a demo booking) was cancelled by the operator.`);
      return { outcome: 'cancelled', booking, message: 'Cancelled. The payment of this booking was only simulated (this computer has no Razorpay keys), so nothing needs to be refunded.' };
    }

    const paymentId = booking.paymentId;
    const result = await this.refund(booking, paymentId, {
      reason: byOperator ? 'Cancelled by the parking operator' : 'Parking time no longer available',
      byOperator,
    });

    if (result.outcome === 'refund_failed' && (await this.alreadyRefunded(paymentId))) {
      booking.status = 'refunded';
      booking.refundedAt = this.now();
      booking.refundError = null;
      this.persist();
      this.log.warn(`Booking ${booking.ref}: Razorpay shows payment ${paymentId} was already refunded in full, so the booking was marked as refunded.`);
      return {
        outcome: 'refunded',
        booking,
        message: `${byOperator ? 'Cancelled. ' : ''}Razorpay shows this payment was already refunded in full, so nothing more was sent.`,
      };
    }

    const amount = money(booking.amountPaise);
    if (result.outcome === 'refunded') {
      const idText = booking.refundId ? ` (Razorpay refund ${booking.refundId})` : '';
      return {
        outcome: 'refunded',
        booking,
        message: `${byOperator ? 'Cancelled. ' : 'Refund sent. '}${amount} is on its way back to the customer's original payment method${idText}. It usually takes 5 to 10 working days to reach them.`,
      };
    }
    return {
      outcome: 'refund_failed',
      booking,
      message:
        `Razorpay did not accept the refund${booking.refundError ? ` (it said: ${booking.refundError})` : ''}. ` +
        `${byOperator ? 'The booking is cancelled and its bay is free. ' : ''}` +
        'It is listed under “Needs attention”. Try again in a moment, or refund it from the Razorpay Dashboard.',
    };
  }

  // For the operator. Real numbers only.
  dashboard() {
    const now = this.now();
    const off = this.config.utcOffsetMinutes;
    const dayStart = S.startMsFromLot(S.lotDateString(now, off), '00:00', off);
    const dayEnd = dayStart + DAY;
    const all = this.store.bookings;
    const paidToday = all.filter((b) => b.status === 'paid' && b.endMs > dayStart && b.startMs < dayEnd);

    const receivedToday = all.filter((b) => b.status === 'paid' && b.paidAt >= dayStart && b.paidAt < dayEnd);
    const lot = {};
    for (const v of VEHICLES) {
      const total = LOT[v].total;
      const bays = new Array(total).fill('f'); // f free, u in use now, b booked later today, h payment in progress
      const hourly = Array.from({ length: 24 }, () => new Set());
      const later = new Set();
      let inUse = 0;
      for (const b of paidToday) {
        if (b.vehicle !== v) continue;
        const i = S.parseBay(b.bay).n - 1;
        if (b.startMs <= now && now < b.endMs) {
          bays[i] = 'u';
          inUse += 1;
        } else if (b.startMs > now) {
          later.add(i);
          if (bays[i] !== 'u') bays[i] = 'b';
        }
        for (let h = 0; h < 24; h++) {
          const from = dayStart + h * HOUR;
          if (b.startMs < from + HOUR && from < b.endMs) hourly[h].add(i);
        }
      }
      let held = 0;
      for (const b of all) {
        if (b.vehicle !== v || b.status !== 'pending' || b.holdUntil <= now) continue;
        held += 1;
        const i = S.parseBay(b.bay).n - 1;
        if (b.startMs <= now && now < b.endMs && bays[i] === 'f') bays[i] = 'h';
      }
      const received = receivedToday.filter((b) => b.vehicle === v);
      lot[v] = {
        total,
        inUse,
        laterToday: later.size,
        free: total - inUse,
        held,
        paymentsToday: received.length,
        revenueToday: received.reduce((sum, b) => sum + b.amountPaise, 0) / 100,
        bays: bays.join(''),
        hourly: hourly.map((s) => s.size),
      };
    }

    const revenuePaise = receivedToday.reduce((sum, b) => sum + b.amountPaise, 0);
    const paymentsToday = receivedToday.length;

    const row = (b) => this.operatorRow(b, now);
    const recent = all
      .filter((b) => b.status === 'paid' || b.status.startsWith('refund') || (b.status === 'cancelled' && b.cancelReason === 'operator'))
      .sort((a, b) => (b.paidAt || b.createdAt) - (a.paidAt || a.createdAt))
      .slice(0, 25)
      .map(row);
    const attention = all.filter((b) => b.status === 'refund_failed' || b.status === 'refund_pending').map(row);

    return {
      serverTime: now,
      utcOffsetMinutes: off,
      dayStart,
      siteName: this.config.siteName,
      paymentMode: this.paymentMode,
      lot,
      revenueToday: revenuePaise / 100,
      paymentsToday,
      recent,
      attention,
    };
  }

  // ---- The owner's view of every booking ------------------------------------------------------------
  // `userById` looks a customer account up (the website passes it in, so this file does not need to know about accounts).
  adminRow(b, userById, now = this.now()) {
    const u = b.customerId && userById ? userById(b.customerId) : null;
    return {
      ...this.operatorRow(b, now),
      createdAt: b.createdAt,
      orderId: b.orderId || null,
      refundedAt: b.refundedAt || null,
      cancelledAt: b.cancelledAt || null,
      customer: u ? { name: u.name, email: u.email } : null,
    };
  }

  // Filters: q (reference, vehicle number, bay, customer name or email, Razorpay ids), status, vehicle, when, from, to
  // (lot dates, on the day the parking starts), sort, page, pageSize. Used by the table and by the CSV download.
  filterBookings(query = {}, userById = null) {
    const now = this.now();
    const off = this.config.utcOffsetMinutes;
    const BOOKED = (b) => b.status === 'paid' || b.status.startsWith('refund') || (b.status === 'cancelled' && b.cancelReason === 'operator');
    const status = ['all', 'booked', 'paid', 'refunded', 'unpaid'].includes(query.status) ? query.status : 'booked';
    const vehicle = VEHICLES.includes(query.vehicle) ? query.vehicle : 'all';
    const when = ['all', 'today', 'upcoming', 'active', 'ended'].includes(query.when) ? query.when : 'all';
    const dateOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const from = dateOk(query.from) ? query.from : null;
    const to = dateOk(query.to) ? query.to : null;
    const today = S.lotDateString(now, off);
    const text = String(query.q === undefined ? '' : query.q).trim().slice(0, 60).toLowerCase();
    const plateText = S.normalizePlate(text);

    const matchesText = (b) => {
      if (!text) return true;
      const u = b.customerId && userById ? userById(b.customerId) : null;
      const hay = [b.ref, b.bay, b.paymentId, b.orderId, b.refundId, u && u.name, u && u.email].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(text) || (plateText.length >= 2 && b.plate.includes(plateText));
    };
    const matchesState = (b) => {
      if (when === 'all') return true;
      if (when === 'today') return S.lotDateString(b.startMs, off) === today;
      if (b.status !== 'paid') return false;
      if (when === 'upcoming') return b.startMs > now;
      if (when === 'active') return b.startMs <= now && now < b.endMs;
      return b.endMs <= now; // ended
    };

    let list = this.store.bookings.filter((b) => {
      if (status === 'booked' && !BOOKED(b)) return false;
      if (status === 'paid' && b.status !== 'paid') return false;
      if (status === 'refunded' && !b.status.startsWith('refund')) return false;
      if (status === 'unpaid' && !(b.status === 'pending' || (b.status === 'cancelled' && b.cancelReason !== 'operator'))) return false;
      if (vehicle !== 'all' && b.vehicle !== vehicle) return false;
      if (from || to) {
        const day = S.lotDateString(b.startMs, off);
        if ((from && day < from) || (to && day > to)) return false;
      }
      return matchesState(b) && matchesText(b);
    });

    const sorts = {
      newest: (a, b) => (b.paidAt || b.createdAt) - (a.paidAt || a.createdAt),
      start_desc: (a, b) => b.startMs - a.startMs,
      start_asc: (a, b) => a.startMs - b.startMs,
      amount_desc: (a, b) => b.amountPaise - a.amountPaise,
    };
    const sort = Object.prototype.hasOwnProperty.call(sorts, query.sort) ? query.sort : 'newest';
    list = list.slice().sort(sorts[sort]);

    const totals = { count: list.length, paidCount: 0, paidPaise: 0, refundedCount: 0, refundedPaise: 0 };
    for (const b of list) {
      if (b.status === 'paid') {
        totals.paidCount += 1;
        totals.paidPaise += b.amountPaise;
      } else if (b.status === 'refunded') {
        totals.refundedCount += 1;
        totals.refundedPaise += b.amountPaise;
      }
    }
    return { list, totals, filters: { status, vehicle, when, from, to, q: text, sort }, now, off };
  }

  allBookings(query = {}, userById = null) {
    const { list, totals, filters, now } = this.filterBookings(query, userById);
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize)) || 25));
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page)) || 1));
    const rows = list.slice((page - 1) * pageSize, page * pageSize).map((b) => this.adminRow(b, userById, now));
    return {
      serverTime: now,
      utcOffsetMinutes: this.config.utcOffsetMinutes,
      filters,
      page,
      pages,
      pageSize,
      total: list.length,
      totals: {
        count: totals.count,
        paidCount: totals.paidCount,
        paid: totals.paidPaise / 100,
        refundedCount: totals.refundedCount,
        refunded: totals.refundedPaise / 100,
      },
      rows,
    };
  }

  // Every booking that matches the filters, as CSV text for a spreadsheet. A cell that starts with = + - or @ would be
  // run as a formula by Excel, and names and vehicle numbers are typed by customers, so those get a leading apostrophe.
  bookingsCsv(query = {}, userById = null) {
    const { list, now } = this.filterBookings(query, userById);
    const off = this.config.utcOffsetMinutes;
    const two = (n) => String(n).padStart(2, '0');
    const stamp = (ms) => {
      if (!ms) return '';
      const p = S.lotParts(ms, off);
      return `${S.lotDateString(ms, off)} ${two(p.h)}:${two(p.mi)}`;
    };
    const cell = (value) => {
      let t = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const head = ['Reference', 'Booked on', 'Paid on', 'Customer name', 'Customer email', 'Vehicle type', 'Vehicle number', 'Bay', 'Parking from', 'Parking until', 'Hours', 'Amount (INR)', 'Status', 'Razorpay payment id', 'Razorpay order id', 'Razorpay refund id'];
    const lines = [head.map(cell).join(',')];
    for (const b of list) {
      const r = this.adminRow(b, userById, now);
      lines.push(
        [
          r.ref,
          stamp(r.createdAt),
          stamp(r.paidAt),
          r.customer ? r.customer.name : '',
          r.customer ? r.customer.email : '',
          r.vehicleLabel,
          r.plate,
          r.bay,
          stamp(b.startMs),
          stamp(b.endMs),
          r.hours,
          (b.amountPaise / 100).toFixed(2),
          r.status === 'cancelled' && r.cancelledByOperator ? 'cancelled by admin' : r.status,
          r.paymentId || '',
          r.orderId || '',
          r.refundId || '',
        ]
          .map(cell)
          .join(',')
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  // ---- The owner's overview and customer list -------------------------------------------------------
  ownerOverview(users) {
    return { ...overview(this.store.bookings, users || [], { now: this.now(), config: this.config }), payments: this.paymentStatus(), siteName: this.config.siteName };
  }

  // One row per customer account: what they have booked and spent. Never includes a password or anything secret.
  customerList(users, query = {}) {
    const now = this.now();
    const text = String(query.q === undefined ? '' : query.q).trim().slice(0, 60).toLowerCase();
    const stats = new Map();
    for (const b of this.store.bookings) {
      if (!b.customerId) continue;
      const c = stats.get(b.customerId) || { paid: 0, paise: 0, refundedPaise: 0, lastStart: 0, nextStart: null };
      if (b.status === 'paid') {
        c.paid += 1;
        c.paise += b.amountPaise;
        c.lastStart = Math.max(c.lastStart, b.startMs);
        if (b.startMs > now && (c.nextStart === null || b.startMs < c.nextStart)) c.nextStart = b.startMs;
      } else if (b.status === 'refunded') {
        c.refundedPaise += b.amountPaise;
      }
      stats.set(b.customerId, c);
    }
    let rows = (users || []).map((u) => {
      const c = stats.get(u.id) || { paid: 0, paise: 0, refundedPaise: 0, lastStart: 0, nextStart: null };
      return { id: u.id, name: u.name, email: u.email, joinedAt: u.createdAt, bookings: c.paid, spent: c.paise / 100, refunded: c.refundedPaise / 100, lastBookingAt: c.lastStart || null, nextBookingAt: c.nextStart };
    });
    if (text) rows = rows.filter((r) => `${r.name} ${r.email}`.toLowerCase().includes(text));
    const sorts = {
      spent: (a, b) => b.spent - a.spent || b.joinedAt - a.joinedAt,
      bookings: (a, b) => b.bookings - a.bookings || b.spent - a.spent,
      newest: (a, b) => b.joinedAt - a.joinedAt,
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    const sort = Object.prototype.hasOwnProperty.call(sorts, query.sort) ? query.sort : 'spent';
    rows.sort(sorts[sort]);
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize)) || 25));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page)) || 1));
    return {
      serverTime: now,
      utcOffsetMinutes: this.config.utcOffsetMinutes,
      filters: { q: text, sort },
      page,
      pages,
      pageSize,
      total: rows.length,
      rows: rows.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  // ---- A customer's own bookings -------------------------------------------------------------------
  // Paid, cancelled-by-the-operator and refunded bookings that were made while signed in as this customer.
  forCustomer(customerId) {
    const now = this.now();
    const off = this.config.utcOffsetMinutes;
    return this.store.bookings
      .filter((b) => b.customerId === customerId && (b.status === 'paid' || b.status === 'refunded' || b.status === 'refund_pending' || b.status === 'refund_failed' || (b.status === 'cancelled' && b.cancelReason === 'operator')))
      .sort((a, b) => b.startMs - a.startMs)
      .map((b) => {
        let state = 'cancelled';
        if (b.status === 'paid') state = b.endMs <= now ? 'completed' : b.startMs <= now ? 'active' : 'upcoming';
        else if (b.status !== 'cancelled') state = 'refunded';
        return {
          ref: b.ref,
          vehicleLabel: LOT[b.vehicle].label,
          plate: S.formatPlate(b.plate),
          bay: b.bay,
          zone: LOT[b.vehicle].zones[S.parseBay(b.bay).zone],
          startMs: b.startMs,
          endMs: b.endMs,
          hours: b.hours,
          window: S.formatWindow(b.startMs, b.endMs, off),
          amount: b.amountPaise / 100,
          state,
        };
      });
  }

  // ---- Analytics for the operator ----------------------------------------------------------------------
  analytics(query) {
    return { ...analytics(this.store.bookings, { now: this.now(), config: this.config, query: query || {} }), paymentMode: this.paymentMode, siteName: this.config.siteName };
  }

  // Sample bookings for a demonstration. Only while payments are simulated; they are in the past and marked sample.
  addSampleData() {
    if (this.paymentMode !== 'demo') {
      throw new HttpError(409, 'not_allowed', 'Sample bookings can only be added when running on your own computer without Razorpay keys. A live site only ever shows real bookings.');
    }
    this.store.bookings = this.store.bookings.filter((b) => !b.sample);
    const made = sampleBookings({ existing: this.store.bookings, now: this.now(), config: this.config, newRef: () => this.newRef() });
    for (const b of made) this.store.add(b);
    this.persist();
    return { added: made.length };
  }

  removeSampleData() {
    const before = this.store.bookings.length;
    this.store.bookings = this.store.bookings.filter((b) => !b.sample);
    if (this.store.bookings.length !== before) this.persist();
    return { removed: before - this.store.bookings.length };
  }
}

function createBookingService(deps) {
  return new BookingService(deps);
}

module.exports = { createBookingService, BookingService, money };
