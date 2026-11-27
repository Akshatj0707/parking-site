'use strict';

/*
 * The invoice of a finished booking.
 *
 * When it is ready: once the visit is over (the vehicle has left, or the booked time ended and the vehicle never came in), so
 * the amounts cannot change any more. A booking that was cancelled with part of the money kept gets an invoice for the part
 * that was kept. A booking that was refunded in full, is still waiting for its refund, or has an extra charge still to pay
 * has none.
 *
 * What it says: the seller, a number, the date, the buyer (the account name, and the vehicle number), what was paid for, and
 * the tax. With a GST number in the settings (INVOICE_GSTIN) it is a TAX INVOICE: the prices already include GST, so the tax is
 * taken out of the total and split into CGST and SGST (parking is a service given at the lot, so the place of supply is the
 * seller's own state). Without one it is a RECEIPT: a seller who is not registered cannot charge GST, so the page says so
 * instead of showing tax.
 *
 * Numbers: INV2627-00001 is the first invoice of the financial year 2026-27 (April to March, lot time). They are given one
 * after the other the first time an invoice is opened, and then never change.
 *
 * "Signed": every invoice carries a verification code that only this website can make (an HMAC over the number, the booking,
 * the total and the date). The code and number are in the QR code on the page, which opens /invoice/check on this website. A
 * printed or forwarded copy that was changed by hand (a different amount) no longer matches.
 */

const crypto = require('crypto');
const S = require('../public/js/shared.js');
const { HttpError } = require('./errors');

const { LOT } = S;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// What came back to the customer. Same rule as the bookings (a partial refund stores its own amount).
const refundedOf = (b) => (Number.isInteger(b.refundAmountPaise) ? b.refundAmountPaise : b.amountPaise);

// The money lines of a booking and their total, in paise. Positive lines were paid; a negative line was given back.
function statement(b) {
  const lines = [];
  if (b.status === 'refunded') {
    lines.push({ key: 'booking', text: 'Parking booking, cancelled before use', paise: b.amountPaise });
    lines.push({ key: 'refund', text: 'Less: refunded to the customer', paise: -refundedOf(b) });
  } else {
    lines.push({ key: 'booking', text: 'Parking fee for the booked time', paise: b.amountPaise });
    if (b.extensionPaise > 0) lines.push({ key: 'extension', text: 'Extra hours added while parked', paise: b.extensionPaise });
    const ov = b.overstay;
    if (ov && ov.status === 'paid' && ov.amountPaise > 0) lines.push({ key: 'overstay', text: 'Extra time after the booked end', paise: ov.amountPaise });
  }
  return { lines, totalPaise: lines.reduce((sum, l) => sum + l.paise, 0) };
}

// { ok: true }, or { ok: false, reason } where reason is not_over, charge_due, refund_open or none.
function eligibility(b, now) {
  if (b.status === 'paid') {
    const ov = b.overstay;
    if (ov && ov.status === 'due') return { ok: false, reason: 'charge_due' };
    if (b.exitAt || (!b.entryAt && now >= b.endMs)) return { ok: true };
    return { ok: false, reason: 'not_over' };
  }
  if (b.status === 'refunded') return statement(b).totalPaise > 0 ? { ok: true } : { ok: false, reason: 'none' };
  if (b.status === 'refund_pending' || b.status === 'refund_failed') return { ok: false, reason: 'refund_open' };
  return { ok: false, reason: 'none' };
}

const WHY = {
  not_over: [409, 'Your invoice is ready when your parking is over and the vehicle has left.'],
  charge_due: [409, 'There is an extra charge to pay at the gate first. The invoice is ready after that.'],
  refund_open: [409, 'A refund is still being sent. The invoice is ready when it is done.'],
  none: [404, 'There is no invoice for this booking.'],
};

// The financial year (April to March) that a moment falls in, on the lot clock. 2026-27 is written 2627 in the number.
function financialYear(ms, offsetMinutes) {
  const p = S.lotParts(ms, offsetMinutes);
  const start = p.mo >= 4 ? p.y : p.y - 1;
  return { label: `${start}-${String(start + 1).slice(2)}`, short: `${String(start).slice(2)}${String(start + 1).slice(2)}` };
}

// The tax inside a price that already includes it, in whole paise: CGST and SGST are each half (an odd paisa goes to SGST).
function splitTax(totalPaise, percent) {
  if (!(percent > 0) || totalPaise <= 0) return { taxablePaise: totalPaise, cgstPaise: 0, sgstPaise: 0 };
  const taxable = Math.round((totalPaise * 100) / (100 + percent));
  const tax = totalPaise - taxable;
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst };
}

const esc = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rupees = (paise) => (paise < 0 ? '-' : '') + (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function createInvoices({ config, bookings, signFor, userById = () => null, now = Date.now }) {
  const off = config.utcOffsetMinutes;
  const settings = config.invoice;
  const longDate = (ms) => {
    const p = S.lotParts(ms, off);
    return `${p.d} ${MONTHS[p.mo - 1]} ${p.y}`;
  };

  // The verification code, 12 characters in three groups, such as 3FA9-10CC-7B2E.
  function codeFor(b) {
    const inv = b.invoice;
    const sig = signFor('invoice', `${inv.no}|${b.ref}|${statement(b).totalPaise}|${inv.issuedAt}`);
    const hex = Buffer.from(sig, 'base64url').toString('hex').toUpperCase().slice(0, 12);
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  }

  function nextNumber(issuedAt) {
    const fy = financialYear(issuedAt, off);
    let top = 0;
    for (const b of bookings.store.bookings) if (b.invoice && b.invoice.fy === fy.label && b.invoice.seq > top) top = b.invoice.seq;
    const seq = top + 1;
    return { fy: fy.label, seq, no: `${settings.prefix}${fy.short}-${String(seq).padStart(5, '0')}` };
  }

  // Everything the page shows. The booking must already have its number (see issue).
  function build(b) {
    const inv = b.invoice;
    const { lines, totalPaise } = statement(b);
    const buyer = b.customerId ? userById(b.customerId) : null;
    const tax = settings.gstin ? splitTax(totalPaise, settings.percent) : null;
    return {
      no: inv.no,
      issuedAt: inv.issuedAt,
      date: longDate(inv.issuedAt),
      kind: settings.gstin ? 'tax' : 'receipt',
      seller: { name: config.businessName, address: config.businessAddress, email: config.supportEmail, gstin: settings.gstin },
      buyer: { name: buyer ? buyer.name : '', plate: S.formatPlate(b.plate) },
      ref: b.ref,
      service: { vehicle: LOT[b.vehicle].label, bay: b.bay, zone: LOT[b.vehicle].zones[S.parseBay(b.bay).zone], window: S.formatWindow(b.startMs, b.endMs, off) },
      lines,
      totalPaise,
      tax: tax ? { percent: settings.percent, sac: settings.sac, ...tax } : null,
      payment: { id: b.paymentId || null, paidAt: b.paidAt ? longDate(b.paidAt) : null, online: b.mode === 'razorpay' },
      test: b.mode !== 'razorpay' || !config.razorpay.live,
      code: codeFor(b),
    };
  }

  // The invoice of a booking, giving it its number the first time. Throws a 404 or 409 that says why there is none yet.
  async function issue(b) {
    const e = eligibility(b, now());
    if (!e.ok) {
      const [status, text] = WHY[e.reason];
      throw new HttpError(status, 'no_invoice', text);
    }
    if (!b.invoice) {
      const issuedAt = now();
      b.invoice = { ...nextNumber(issuedAt), issuedAt };
      await bookings.persistNow();
    }
    return build(b);
  }

  // Is this the number and code of an invoice this website made, for the amounts it holds today?
  function verify(no, code) {
    const wanted = String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    const b = typeof no === 'string' && no.length <= 20 ? bookings.store.bookings.find((x) => x.invoice && x.invoice.no === no) : null;
    if (!b || wanted.length !== 12 || !eligibility(b, now()).ok) return null;
    const have = codeFor(b).replace(/-/g, '');
    return crypto.timingSafeEqual(Buffer.from(have), Buffer.from(wanted)) ? build(b) : null;
  }

  // The invoice as a block of HTML (every value from the booking or the settings is escaped). `qr` is the SVG of the code.
  function html(inv, qr, checkUrl) {
    const tax = inv.kind === 'tax';
    const row = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const lines = inv.lines.map((l) => `<tr><td>${esc(l.text)}</td>${tax ? `<td class="num">${esc(inv.tax.sac)}</td>` : ''}<td class="num">${rupees(l.paise)}</td></tr>`).join('');
    const taxRows = tax
      ? `<tr><th scope="row">Taxable value</th><td class="num">${rupees(inv.tax.taxablePaise)}</td></tr>` +
        `<tr><th scope="row">CGST @ ${esc(inv.tax.percent / 2)}%</th><td class="num">${rupees(inv.tax.cgstPaise)}</td></tr>` +
        `<tr><th scope="row">SGST @ ${esc(inv.tax.percent / 2)}%</th><td class="num">${rupees(inv.tax.sgstPaise)}</td></tr>`
      : '';
    const payLine = inv.payment.online
      ? `Paid online with Razorpay${inv.payment.paidAt ? ` on ${esc(inv.payment.paidAt)}` : ''}${inv.payment.id ? ` (payment ${esc(inv.payment.id)})` : ''}.`
      : 'Paid at the lot or by a simulated payment.';
    return (
      '<article class="invoice" aria-label="' + (tax ? 'Tax invoice' : 'Receipt') + '">' +
      (inv.test ? '<p class="invoice-test" role="note"><b>Test copy.</b> No real payment was made, so this is not a valid invoice.</p>' : '') +
      '<header class="invoice-head"><div><h1>' + (tax ? 'Tax invoice' : 'Receipt') + '</h1><p class="muted">Original for the customer</p></div>' +
      '<div class="invoice-seller"><b>' + esc(inv.seller.name) + '</b>' +
      (inv.seller.address ? '<br>' + esc(inv.seller.address) : '') +
      (inv.seller.email ? '<br>' + esc(inv.seller.email) : '') +
      (inv.seller.gstin ? '<br>GSTIN: <b>' + esc(inv.seller.gstin) + '</b>' : '') +
      '</div></header>' +
      '<dl class="invoice-meta">' +
      row(tax ? 'Invoice number' : 'Receipt number', esc(inv.no)) +
      row('Date', esc(inv.date)) +
      row('Booking reference', esc(inv.ref)) +
      (tax ? row('Place of supply', 'The parking lot (state code ' + esc(inv.seller.gstin.slice(0, 2)) + ')') : '') +
      '</dl>' +
      '<section class="invoice-buyer"><h2>Billed to</h2><p>' + (inv.buyer.name ? esc(inv.buyer.name) + '<br>' : '') + 'Vehicle ' + esc(inv.buyer.plate) + '</p></section>' +
      '<section class="invoice-service"><h2>Service</h2><p>Parking, ' + esc(inv.service.vehicle) + ', bay ' + esc(inv.service.bay) + ' (' + esc(inv.service.zone) + ')<br>' + esc(inv.service.window) + '</p></section>' +
      '<table class="invoice-lines"><thead><tr><th scope="col">Description</th>' + (tax ? '<th scope="col" class="num">SAC</th>' : '') + '<th scope="col" class="num">Amount (₹)' + (tax ? ', GST included' : '') + '</th></tr></thead><tbody>' + lines + '</tbody></table>' +
      '<table class="invoice-total"><tbody>' + taxRows + '<tr class="grand"><th scope="row">Total</th><td class="num">₹ ' + rupees(inv.totalPaise) + '</td></tr></tbody></table>' +
      '<p class="invoice-pay">' + payLine + '</p>' +
      (tax ? '' : '<p class="fine">The seller has not given a GST registration number, so this is a receipt and not a tax invoice. No GST is shown.</p>') +
      '<footer class="invoice-verify"><div class="invoice-qr" role="img" aria-label="QR code that checks this invoice">' + qr + '</div>' +
      '<p><b>Verification code ' + esc(inv.code) + '</b><br>Scan the QR code, or open <span class="nowrap">' + esc(checkUrl) + '</span>, to check that this website made this invoice and that the amount has not been changed.</p></footer>' +
      '</article>'
    );
  }

  return { issue, verify, html, eligibility: (b) => eligibility(b, now()) };
}

module.exports = { createInvoices, eligibility, statement, splitTax, financialYear };
