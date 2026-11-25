/*
 * The pass page: the two QR codes of a paid booking, where the vehicle is in its visit, paying for extra parking time after the
 * booked end, and buying more hours before it.
 *
 * The address holds the pass token (?t=...). The server decides everything: whether the QR codes work, what the extra
 * time costs, whether a payment is real. This page only asks and shows, and asks again every few seconds so it notices
 * when the staff scan a QR code.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees } = B;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const token = new URLSearchParams(window.location.search).get('t') || '';
  const els = { banner: $('pass-banner'), pay: $('pass-pay'), qr: $('pass-qr'), details: $('pass-details') };

  let info = null; // the last answer of /api/pass
  let cards = null; // the two QR cards, built once so the pictures do not flicker
  let paying = false; // true from pressing Pay until the payment is confirmed or given up
  let note = null; // { kind, text } shown above the pay button
  let selected = null; // how many extra hours are chosen in the "need more time" box
  let paySig = ''; // what the pay box shows now, so the 3-second refresh does not redraw it for nothing
  let offset = 0; // server clock minus this phone's clock

  const clock = (ms) => S.formatTime(ms, info.utcOffsetMinutes);
  const nowMs = () => Date.now() + offset;

  // ---- Reading the answer ------------------------------------------------------------------------------------------
  async function refresh() {
    try {
      info = await B.api('/api/pass?t=' + encodeURIComponent(token));
    } catch (err) {
      if (!info) {
        els.banner.replaceChildren(h('p', { class: 'msg err', role: 'alert' }, err.status === 400 || err.status === 404 ? 'This pass link is not valid. Open the pass from your booking confirmation or from My bookings.' : err.message));
      }
      return;
    }
    offset = info.serverTime - Date.now();
    render();
  }

  // ---- Banner ----------------------------------------------------------------------------------------------------------
  function bannerFor(g, b) {
    const grace = info.rules.graceMinutes;
    switch (g.stage) {
      case 'void':
        return { tone: 'bad', title: 'This booking has no QR codes', text: 'It was cancelled, refunded or never paid, so the entry and exit QR codes do not work.' };
      case 'upcoming':
        return { tone: 'info', title: 'Your booking has not started yet', text: `The entry QR code starts working at ${clock(b.startMs - info.rules.earlyMinutes * S.MIN)}. Your booking starts at ${clock(b.startMs)}.` };
      case 'ready':
        if (g.released) {
          return { tone: 'warn', title: 'Your bay was released', text: `The vehicle was not scanned in within ${info.rules.noShowMinutes} minutes of the start, so bay ${b.bay} was released for other customers. The amount is not refunded. If you arrive now you can still come in if the bay is free; if someone else has it, the staff give you another free bay.` };
        }
        return { tone: 'ok', title: 'Show the entry QR at the gate', text: `Your bay is ${b.bay} (${b.zone}). The staff scan the entry QR code once, then you park.` };
      case 'inside': {
        const left = b.endMs - nowMs();
        const text = left > 0 ? `Your booked time ends at ${clock(b.endMs)} (${B.duration(left)} from now). Show the exit QR code when you leave.` : `Your booked time ended at ${clock(b.endMs)}. You can still leave free of charge for a few more minutes (${grace} minutes in all).`;
        const more = info.extended ? ` You added ${info.extended.hours} extra ${info.extended.hours === 1 ? 'hour' : 'hours'} (${rupees(info.extended.amount)}).` : '';
        return { tone: left > 0 ? 'ok' : 'warn', title: 'You are parked', text: text + more };
      }
      case 'overstaying': {
        const e = g.estimate;
        return { tone: 'warn', title: `${e.overMinutes} min over your booked time`, text: `If you leave now you pay ${rupees(e.amount)} (${e.hours} extra ${e.hours === 1 ? 'hour' : 'hours'} at ${rupees(b.rate)} an hour). The charge grows by ${rupees(b.rate)} with every new hour. Show the exit QR code when you leave.` };
      }
      case 'payment_due':
        return { tone: 'warn', title: 'Pay the extra time to leave', text: 'The staff scanned your exit QR code. Pay below, and as soon as it is paid you can drive out.' };
      case 'left': {
        const ov = g.overstay;
        const extra = ov && ov.status === 'paid' ? ` You paid ${rupees(ov.amount)} for the extra time.` : ov && ov.status === 'waived' ? ' The extra charge was waived by the staff.' : '';
        return { tone: 'done', title: 'Visit complete', text: `You left at ${clock(g.exitAt)}. Thank you for parking with ${info.siteName}.${extra}` };
      }
      default:
        return { tone: 'bad', title: 'The booked time is over', text: 'This vehicle was never scanned in, so the QR codes no longer work. Book again for a new visit.' };
    }
  }

  function renderBanner() {
    const b = info.booking;
    const msg = bannerFor(info.gate, b);
    const moved = info.bayMoved && (info.gate.stage === 'upcoming' || info.gate.stage === 'ready');
    els.banner.replaceChildren(
      h('div', { class: 'gate-banner ' + msg.tone }, h('h2', null, msg.title), h('p', null, msg.text), moved ? h('p', null, `Your bay was changed from ${info.bayMoved.from} to ${info.bayMoved.to} at ${clock(info.bayMoved.at)}. Go to bay ${b.bay}.`) : null)
    );
  }

  // ---- Paying the extra time -------------------------------------------------------------------------------------------
  function testNote() {
    const p = info.payments;
    if (p.mode !== 'razorpay' || !/^rzp_test_/.test(p.keyId || '')) return null;
    return h(
      'p',
      { class: 'msg info', role: 'note' },
      h('b', null, 'Test mode: '),
      'no real money is taken. In the payment window choose UPI and enter ',
      h('b', null, 'success@razorpay'),
      ', or choose Card and use 4111 1111 1111 1111 with any future expiry and any CVV.'
    );
  }

  function payButton(amount, onclick) {
    const demo = info.payments.mode === 'demo';
    if (info.payments.mode === 'unavailable') return h('p', { class: 'msg info' }, 'Online payment is switched off for now. Please pay the staff at the gate.');
    return h('button', { type: 'button', class: 'btn btn-accent btn-block btn-tall', onclick }, demo ? 'Pay ' + rupees(amount) + ' (simulated)' : 'Pay ' + rupees(amount));
  }

  function renderPay() {
    const g = info.gate;
    const due = g.stage === 'payment_due' && g.overstay;
    const more = g.stage === 'inside' && info.extend;
    if (!due && !more) {
      els.pay.replaceChildren();
      paySig = '';
      return;
    }
    if (paying) return; // do not redraw under the payment window
    if (more && !info.extend.atMaximum) {
      const ok = info.extend.options.find((o) => o.hours === selected && o.available);
      if (!ok) selected = (info.extend.options.find((o) => o.available) || {}).hours || null;
    }
    const sig = JSON.stringify([due ? g.overstay : info.extend, selected, note, info.payments.mode]);
    if (sig === paySig && els.pay.firstChild) return;
    paySig = sig;
    els.pay.replaceChildren(due ? overstayBox(g.overstay) : extendBox(info.extend));
  }

  function overstayBox(ov) {
    return h(
      'div',
      { class: 'pay-box' },
      h('h2', null, 'Extra parking time'),
      h('p', null, `${ov.hours} extra ${ov.hours === 1 ? 'hour' : 'hours'} after your booked end at ${rupees(ov.rate)} an hour.`),
      h('p', { class: 'pay-amount' }, rupees(ov.amount)),
      note ? h('p', { class: 'msg ' + note.kind, role: note.kind === 'err' ? 'alert' : null }, note.text) : null,
      testNote(),
      payButton(ov.amount, () => pay(OVERSTAY)),
      h('p', { class: 'fine' }, 'Your exit is complete as soon as the payment goes through.')
    );
  }

  // Before the booked end: add hours to this booking, as long as the bay is free for them.
  function extendBox(ex) {
    if (ex.atMaximum) {
      return h('div', { class: 'pay-box' }, h('h2', null, 'Need more time?'), h('p', null, `This booking is already as long as it can be (${ex.maxTotalHours} hours). Book again for more time.`));
    }
    const choice = ex.options.find((o) => o.hours === selected);
    const buttons = ex.options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn ' + (o.hours === selected ? 'btn-navy' : 'btn-outline'),
          'aria-pressed': o.hours === selected ? 'true' : 'false',
          disabled: !o.available,
          onclick: () => {
            selected = o.hours;
            note = null;
            paySig = '';
            renderPay();
          },
        },
        h('span', { class: 'ext-h' }, `+${o.hours} ${o.hours === 1 ? 'hour' : 'hours'}`),
        h('span', { class: 'ext-p' }, rupees(o.amount))
      )
    );
    const blocked = ex.options.filter((o) => !o.available);
    const free = ex.options.length - blocked.length; // a clash with a later booking also blocks every longer choice
    return h(
      'div',
      { class: 'pay-box extend-box' },
      h('h2', null, 'Need more time?'),
      h('p', null, `Your booked time ends at ${clock(info.booking.endMs)}. Add more hours now and the bay stays yours.`),
      h('div', { class: 'ext-options', role: 'group', 'aria-label': 'Extra hours' }, ...buttons),
      blocked.length ? h('p', { class: 'fine' }, blocked[0].reason + (free ? ` You can add up to ${free} ${free === 1 ? 'hour' : 'hours'}.` : '')) : null,
      choice ? h('p', { class: 'fine' }, `${choice.hours} more ${choice.hours === 1 ? 'hour' : 'hours'} for ${rupees(choice.amount)}: your parking then lasts until ${choice.until}.`) : null,
      note ? h('p', { class: 'msg ' + note.kind, role: note.kind === 'err' ? 'alert' : null }, note.text) : null,
      testNote(),
      choice ? payButton(choice.amount, () => pay(EXTEND)) : h('p', { class: 'msg info' }, 'The bay is booked by someone else right after your time, so it cannot be extended.'),
      h('p', { class: 'fine' }, `The time is added as soon as the payment goes through. The bay is held for you for ${ex.holdMinutes} minutes while you pay.`)
    );
  }

  let razorpayScript = null;
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (!razorpayScript) {
      razorpayScript = new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = 'https://checkout.razorpay.com/v1/checkout.js';
        tag.async = true;
        tag.onload = () => resolve();
        tag.onerror = () => {
          razorpayScript = null;
          tag.remove();
          reject(new Error('Razorpay Checkout did not load'));
        };
        document.head.append(tag);
      });
    }
    return razorpayScript;
  }

  function stopPaying(text, kind) {
    paying = false;
    paySig = '';
    note = text ? { kind: kind || 'info', text } : null;
    renderPay();
  }

  // The two things that are paid on this page: the hours after the booked end, and more hours before it.
  const OVERSTAY = { start: '/api/pass/overstay/start', demo: '/api/pass/overstay/demo-confirm', verify: '/api/pass/overstay/verify', body: () => ({ t: token }), gone: 'nothing_due' };
  const EXTEND = { start: '/api/pass/extend/start', demo: '/api/pass/extend/demo-confirm', verify: '/api/pass/extend/verify', body: () => ({ t: token, hours: selected }), gone: 'not_extendable' };
  let kind = OVERSTAY; // what the open payment window is for

  async function pay(what) {
    if (paying) return;
    paying = true;
    kind = what;
    note = null;
    els.pay.querySelectorAll('button').forEach((x) => (x.disabled = true));
    let start;
    try {
      start = await B.post(what.start, what.body());
    } catch (err) {
      if (err.code === what.gone || err.code === 'not_available') {
        stopPaying(err.code === 'not_available' ? err.message : null, 'err');
        return refresh();
      }
      return stopPaying(err.message, 'err');
    }
    const payment = start.payment;
    if (payment.mode === 'demo') {
      try {
        await B.post(what.demo, { t: token });
      } catch (err) {
        return stopPaying(err.message, 'err');
      }
      stopPaying(what === EXTEND ? 'The extra time was added.' : null, 'ok');
      return refresh();
    }
    try {
      await loadRazorpay();
    } catch (err) {
      return stopPaying('We could not load the payment window. Check your connection and press Pay again.', 'err');
    }
    let failure = null;
    const checkout = new window.Razorpay({
      key: payment.keyId,
      amount: payment.amount,
      currency: payment.currency,
      name: payment.name,
      description: payment.description,
      order_id: payment.orderId,
      theme: { color: '#1b3fd8' },
      handler: (response) => verify(response),
      modal: {
        confirm_close: true,
        ondismiss: () => {
          if (!paying || confirming) return;
          stopPaying(failure ? failure + ' You can try again.' : 'The payment window was closed. Press Pay when you are ready.', failure ? 'err' : 'info');
        },
      },
    });
    checkout.on('payment.failed', (event) => {
      failure = (event && event.error && event.error.description) || 'The payment did not go through.';
    });
    checkout.open();
  }

  let confirming = false;
  async function verify(response) {
    confirming = true;
    els.pay.replaceChildren(h('div', { class: 'pay-box' }, h('div', { class: 'working' }, h('span', { class: 'spinner' }), 'Confirming your payment…'), h('p', { class: 'fine' }, 'Please keep this page open.')));
    const body = { t: token, razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature };
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await B.post(kind.verify, body);
        last = null;
        break;
      } catch (err) {
        last = err;
        if (err.status >= 400 && err.status < 500 && err.status !== 429) break;
        if (attempt < 2) await sleep(1500 * (attempt + 1));
      }
    }
    confirming = false;
    if (last) {
      stopPaying(`${last.message} Do not pay again. Payment ID: ${response.razorpay_payment_id || 'not shown'}. Show this to the staff.`, 'err');
      return;
    }
    await refresh();
    stopPaying(kind === EXTEND ? 'The extra time was added.' : null, 'ok');
  }

  // ---- The two QR codes ------------------------------------------------------------------------------------------------
  function qrCard(kind, title, tag) {
    const img = h('img', { src: info.qr[kind], alt: title + ' to show to the staff', width: '300', height: '300' });
    const note = h('p', { class: 'qr-note' });
    const node = h('div', { class: 'qr-card ' + kind }, h('span', { class: 'qr-tag' }, tag), h('h2', null, title), img, note);
    return { node, note, stamp: null };
  }

  function renderQr() {
    const g = info.gate;
    if (!info.qr) {
      cards = null;
      els.qr.replaceChildren();
      return;
    }
    if (!cards) {
      cards = { in: qrCard('in', 'Entry QR', 'Show when you come in'), out: qrCard('out', 'Exit QR', 'Show when you leave') };
      els.qr.replaceChildren(h('div', { class: 'qr-grid' }, cards.in.node, cards.out.node));
    }
    const stamp = (card, text) => {
      if (text && !card.stamp) {
        card.stamp = h('span', { class: 'qr-stamp', 'aria-hidden': 'true' }, text);
        card.node.append(card.stamp);
      }
      if (!text && card.stamp) {
        card.stamp.remove();
        card.stamp = null;
      }
    };
    const entered = Boolean(g.entryAt);
    const left = Boolean(g.exitAt);
    const scannedOut = Boolean(g.exitScanAt);

    cards.in.node.classList.toggle('used', entered);
    cards.in.node.classList.toggle('waiting', !entered && g.stage === 'upcoming');
    stamp(cards.in, entered ? 'USED' : null);
    cards.in.note.textContent = entered ? `Scanned in at ${clock(g.entryAt)}` : g.stage === 'upcoming' ? `Works from ${clock(info.booking.startMs - info.rules.earlyMinutes * S.MIN)}` : g.stage === 'ready' ? 'Show this at the gate' : '';

    cards.out.node.classList.toggle('used', left || scannedOut);
    cards.out.node.classList.toggle('waiting', !entered);
    stamp(cards.out, left ? 'USED' : scannedOut ? 'SCANNED' : null);
    cards.out.note.textContent = left ? `Left at ${clock(g.exitAt)}` : scannedOut ? `Scanned at ${clock(g.exitScanAt)}. Pay to leave.` : entered ? 'Show this when you leave' : 'Works after you have come in';
  }

  // ---- Details --------------------------------------------------------------------------------------------------------
  function row(label, value) {
    return h('div', null, h('dt', null, label), h('dd', null, value));
  }

  function renderDetails() {
    const b = info.booking;
    els.details.replaceChildren(
      h(
        'section',
        { class: 'pass-card', 'aria-label': 'Booking details' },
        h('div', { class: 'pass-top' }, h('div', { class: 'stack g8' }, h('p', { class: 'hold-line' }, 'Your bay'), h('p', { class: 'bay-big' }, b.bay), h('p', { class: 'hold-line' }, b.zone)), h('div', { class: 'ref-box' }, h('small', null, 'Booking reference'), h('b', null, b.ref))),
        h('dl', { class: 'facts' }, row('Vehicle', `${b.vehicleLabel}, ${b.plate}`), row('Booked time', b.window), row('Rate', rupees(b.rate) + ' an hour'))
      )
    );
  }

  function render() {
    $('grace').textContent = String(info.rules.graceMinutes);
    renderBanner();
    renderPay();
    renderQr();
    if (!els.details.firstChild) renderDetails();
  }

  if (!token) {
    els.banner.replaceChildren(h('p', { class: 'msg err', role: 'alert' }, 'This page needs the pass link from your booking confirmation. Open your pass from the confirmation page or from My bookings.'));
  } else {
    B.poll(refresh, 3000);
  }
})();
