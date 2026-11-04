/*
 * The booking page: choose a vehicle, time and bay, hold the bay, pay with Razorpay, show the confirmation.
 *
 * The server decides everything that matters (prices, who gets a bay, whether a payment is real).
 * This page only asks and shows. It never works out a price that the server has not confirmed.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees } = B;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const els = {
    grid: $('book-grid'),
    main: $('book-main'),
    vehicleRow: $('vehicle-row'),
    plate: $('plate'),
    plateHelp: $('plate-help'),
    dayRow: $('day-row'),
    time: $('time'),
    hoursRow: $('hours-row'),
    zoneRow: $('zone-row'),
    bayGrid: $('bay-grid'),
    bayCount: $('bay-count'),
    bayHint: $('bay-hint'),
    summary: $('summary'),
  };

  const state = {
    cfg: null,
    vehicle: 'car',
    plate: null, // the vehicle number once it is valid, otherwise null
    slots: [], // every start time that can be booked: { ms, date, time }
    days: [], // the dates that have at least one slot
    date: null,
    time: null,
    hours: 1,
    zone: 0,
    bay: null,
    avail: null, // the server's answer for the chosen vehicle, time and length
    loading: true,
    seq: 0, // lets us ignore answers that arrive late
    stage: 'choose', // choose, paying, demo, confirming, done, lost or unsure
    busy: false,
    checkout: null, // { booking, payment } once the server is holding a bay for us
    booking: null, // the confirmed booking
    note: null, // { kind: 'err' | 'info' | 'ok', text, link? }
    expired: false,
    problem: null, // what to say in place of the form when the page cannot start at all
    lostText: '',
    paymentId: null,
    checkoutPlate: '',
  };

  let plateCtl = null;
  let clockTimer = null;
  let clockNode = null;

  // ---- Remembering a held bay across a page refresh (this browser tab only) ----------------------------------
  const KEY = 'bayfind.checkout';
  function saveCheckout() {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(state.checkout));
    } catch (err) {
      // fine: the page works without it
    }
  }
  function clearCheckout() {
    state.checkout = null;
    state.expired = false;
    try {
      window.sessionStorage.removeItem(KEY);
    } catch (err) {
      // fine
    }
  }
  function restoreCheckout() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(KEY) || 'null');
      const ok =
        saved && saved.booking && saved.payment &&
        /^bk_[0-9a-f]{16}$/.test(saved.booking.id) &&
        saved.payment.mode === state.cfg.payments.mode &&
        saved.booking.holdUntil > B.now();
      if (!ok) {
        window.sessionStorage.removeItem(KEY);
        return false;
      }
      state.checkout = saved;
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---- Times you can book ---------------------------------------------------------------------------------------
  function buildSlots() {
    const cfg = state.cfg;
    const off = cfg.utcOffsetMinutes;
    const step = cfg.slotMinutes * S.MIN;
    const t = B.now();
    const earliestOk = t - cfg.startGraceMinutes * S.MIN;
    let ms = S.slotFloor(earliestOk, off, cfg.slotMinutes);
    if (ms < earliestOk) ms += step;
    const last = t + cfg.maxAdvanceDays * S.DAY;
    const slots = [];
    for (; ms <= last; ms += step) slots.push({ ms, date: S.lotDateString(ms, off), time: B.lotTime(ms, cfg) });
    state.slots = slots;
    state.days = [...new Set(slots.map((s) => s.date))];
  }

  function slotsOnDay(date) {
    return state.slots.filter((s) => s.date === date);
  }

  function ensureSelection() {
    if (!state.days.includes(state.date)) state.date = state.days[0] || null;
    const onDay = slotsOnDay(state.date);
    if (!onDay.some((s) => s.time === state.time)) state.time = onDay.length ? onDay[0].time : null;
  }

  // ---- The three choice panels ----------------------------------------------------------------------------------
  const chipProps = (selected) => ({ type: 'button', 'aria-pressed': String(selected) });
  const hoursText = (n) => n + (n === 1 ? ' hour' : ' hours');

  function renderVehicle() {
    const cfg = state.cfg;
    els.vehicleRow.replaceChildren(
      ...S.VEHICLES.map((v) => {
        const r = cfg.rates[v];
        return h(
          'button',
          { ...chipProps(state.vehicle === v), class: 'chip vehicle-chip', onclick: () => chooseVehicle(v) },
          B.icon(v === 'car' ? 'car' : 'bike', 'ico-lg'),
          h('span', { class: 't' }, h('b', null, cfg.lot[v].label), h('span', null, `From ${rupees(Math.min(r.weekday, r.weekend))} an hour`))
        );
      })
    );
  }

  function renderDays() {
    const cfg = state.cfg;
    const off = cfg.utcOffsetMinutes;
    const today = S.lotDateString(B.now(), off);
    const tomorrow = S.lotDateString(B.now() + S.DAY, off);
    els.dayRow.replaceChildren(
      ...state.days.map((date) => {
        const first = slotsOnDay(date)[0];
        const dayType = S.dayTypeFor(first.ms, cfg);
        const shortDate = S.formatDate(first.ms, off); // Wed 21 Oct
        const label = date === today ? 'Today, ' + shortDate.split(' ').slice(1).join(' ') : date === tomorrow ? 'Tomorrow, ' + shortDate.split(' ').slice(1).join(' ') : shortDate;
        return h(
          'button',
          { ...chipProps(state.date === date), class: 'chip chip-day', onclick: () => chooseDay(date) },
          h('span', null, label),
          h('small', null, `${dayType === 'weekend' ? 'Weekend' : 'Weekday'}, ${rupees(cfg.rates[state.vehicle][dayType])} an hour`)
        );
      })
    );
  }

  function renderTimes() {
    const off = state.cfg.utcOffsetMinutes;
    els.time.replaceChildren(...slotsOnDay(state.date).map((s) => h('option', { value: s.time }, S.formatTime(s.ms, off))));
    if (state.time) els.time.value = state.time;
  }

  function renderHours() {
    els.hoursRow.replaceChildren(
      ...state.cfg.hoursOptions.map((n) => h('button', { ...chipProps(state.hours === n), class: 'chip chip-lg', onclick: () => chooseHours(n) }, hoursText(n)))
    );
  }

  function renderZones() {
    const lot = state.cfg.lot[state.vehicle];
    els.zoneRow.replaceChildren(
      ...lot.zones.map((name, i) => {
        const free = state.avail ? state.avail.zones[i].free : null;
        return h(
          'button',
          { ...chipProps(state.zone === i), class: 'chip', disabled: free === 0, onclick: () => chooseZone(i) },
          name,
          free === null ? null : h('span', null, ` (${free} free)`)
        );
      })
    );
  }

  function renderBays() {
    const a = state.avail;
    els.bayGrid.setAttribute('aria-busy', String(state.loading));
    if (!a) {
      if (state.loading) {
        els.bayGrid.replaceChildren(...Array.from({ length: 24 }, () => h('div', { class: 'skeleton' })));
        els.bayCount.textContent = 'Checking the bays…';
      } else {
        els.bayGrid.replaceChildren(h('button', { type: 'button', class: 'btn btn-outline', onclick: availabilityChanged }, 'Try again'));
        els.bayCount.textContent = '';
      }
      els.bayHint.textContent = '';
      return;
    }
    const lot = state.cfg.lot[state.vehicle];
    const taken = new Set(a.taken);
    const start = state.zone * lot.perZone + 1;
    const nodes = [];
    for (let n = start; n < start + lot.perZone; n++) {
      const id = S.bayId(state.vehicle, n);
      const isTaken = taken.has(id);
      nodes.push(
        h('button', { ...chipProps(state.bay === id), class: 'bay', disabled: isTaken, 'aria-label': `Bay ${id}, ${isTaken ? 'taken' : 'free'}`, onclick: (e) => chooseBay(id, e.currentTarget) }, id)
      );
    }
    els.bayGrid.replaceChildren(...nodes);
    els.bayCount.textContent = `${a.free} of ${a.total} free for this time`;
    els.bayHint.textContent = a.free === 0 ? 'Every bay is taken for this time. Try another time or day.' : 'We picked the first free bay for you. Tap another one if you prefer.';
  }

  // ---- Choosing ---------------------------------------------------------------------------------------------------
  function availabilityChanged() {
    state.avail = null;
    state.loading = true;
    state.note = null;
    renderZones();
    renderBays();
    renderSummary();
    loadAvailability();
  }

  function chooseVehicle(v) {
    if (v === state.vehicle || state.stage !== 'choose') return;
    state.vehicle = v;
    state.bay = null;
    state.zone = 0;
    renderVehicle();
    renderDays();
    availabilityChanged();
  }

  function chooseDay(date) {
    if (state.stage !== 'choose') return;
    state.date = date;
    ensureSelection();
    renderDays();
    renderTimes();
    availabilityChanged();
  }

  function chooseHours(n) {
    if (state.stage !== 'choose') return;
    state.hours = n;
    renderHours();
    availabilityChanged();
  }

  function chooseZone(i) {
    if (state.stage !== 'choose') return;
    state.zone = i;
    state.bay = firstFree(i);
    state.note = null;
    renderZones();
    renderBays();
    renderSummary();
  }

  function chooseBay(id, button) {
    if (state.stage !== 'choose') return;
    state.bay = id;
    state.note = null;
    for (const b of els.bayGrid.children) b.setAttribute('aria-pressed', String(b.textContent === id));
    if (button) {
      button.classList.remove('pop');
      void button.offsetWidth; // restart the little pop animation
      button.classList.add('pop');
    }
    renderSummary();
  }

  function firstFree(zone) {
    if (!state.avail) return null;
    const lot = state.cfg.lot[state.vehicle];
    const taken = new Set(state.avail.taken);
    for (let n = zone * lot.perZone + 1; n <= (zone + 1) * lot.perZone; n++) {
      const id = S.bayId(state.vehicle, n);
      if (!taken.has(id)) return id;
    }
    return null;
  }

  // Keep the chosen bay if it is still free, otherwise pick the first free one, starting with the chosen zone.
  function pickDefaultBay() {
    const a = state.avail;
    if (!a) return;
    const taken = new Set(a.taken);
    const parsed = state.bay ? S.parseBay(state.bay) : null;
    if (parsed && parsed.vehicle === state.vehicle && !taken.has(state.bay)) {
      state.zone = parsed.zone;
      return;
    }
    const zones = state.cfg.lot[state.vehicle].zones.map((name, i) => i);
    const order = [state.zone, ...zones.filter((i) => i !== state.zone)];
    for (const z of order) {
      const id = firstFree(z);
      if (id) {
        state.zone = z;
        state.bay = id;
        return;
      }
    }
    state.bay = null;
  }

  async function loadAvailability(retry = 0) {
    const seq = ++state.seq;
    const query = new URLSearchParams({ vehicle: state.vehicle, date: state.date, time: state.time, hours: String(state.hours) });
    let data = null;
    let failure = null;
    try {
      data = await B.api('/api/availability?' + query);
    } catch (err) {
      failure = err;
    }
    if (seq !== state.seq) return; // the person changed something while we waited

    if (failure && (failure.code === 'too_early' || failure.code === 'too_late') && retry < 2) {
      buildSlots();
      ensureSelection();
      renderDays();
      renderTimes();
      state.note = { kind: 'info', text: 'Time has moved on, so we updated the start times. Please check your start time.' };
      return loadAvailability(retry + 1);
    }

    state.loading = false;
    state.avail = data;
    if (failure) state.note = { kind: 'err', text: failure.message };
    pickDefaultBay();
    renderZones();
    renderBays();
    renderSummary();
  }

  // ---- The summary box on the right (it changes with every step) ---------------------------------------------------------
  function rows(items) {
    return h('dl', { class: 'sum-list' }, items.map(([k, v]) => h('div', { class: 'sum-row' }, h('dt', null, k), h('dd', null, v))));
  }

  function noteNode() {
    const n = state.note;
    if (!n) return null;
    return h('p', { class: 'msg ' + n.kind, role: n.kind === 'err' ? 'alert' : null }, n.text, n.link ? [' ', h('a', { href: n.link.href }, n.link.text)] : null);
  }

  function holdLine() {
    if (!state.checkout || state.expired) return null;
    const left = state.checkout.booking.holdUntil - B.now();
    clockNode = h('b', null, B.clock(left));
    return h('p', { class: 'hold-line' }, 'Time left to pay: ', clockNode);
  }

  function summaryChoose() {
    const cfg = state.cfg;
    const a = state.avail;
    const lot = cfg.lot[state.vehicle];
    const mode = cfg.payments.mode;
    const bayText = a && state.bay ? `${state.bay}, ${lot.zones[S.parseBay(state.bay).zone]}` : '–';
    const ready = Boolean(a && state.bay && !state.loading);
    const off = mode === 'unavailable';

    let hint = '';
    if (off) hint = 'Online booking is temporarily unavailable. Please try again soon.';
    else if (a && !state.bay) hint = 'No bays are free at this time. Try another time or day.';
    else if (!state.plate) hint = 'Enter your vehicle number to continue.';

    let label = 'Pay';
    if (mode === 'demo') label = 'Continue to payment';
    else if (a) label = 'Pay ' + rupees(a.amount);

    const fine =
      mode === 'demo'
        ? `Payment is simulated on this computer. Your bay is held for ${cfg.holdMinutes} minutes once you continue.`
        : `Secure payment by Razorpay. Your bay is held for ${cfg.holdMinutes} minutes once you press Pay.`;

    return [
      h('h2', null, 'Your booking'),
      rows([
        ['Vehicle', lot.label + (state.plate ? ', ' + S.formatPlate(state.plate) : '')],
        ['When', a ? a.window : '–'],
        ['Length', hoursText(state.hours)],
        ['Bay', bayText],
        ['Rate', a ? `${rupees(a.rate)} an hour (${a.dayType})` : '–'],
      ]),
      h('div', { class: 'sum-total' }, h('p', null, 'Total'), h('p', { class: 'amt' }, a ? rupees(a.amount) : '–')),
      hint ? h('p', { class: 'hold-line' }, hint) : null,
      noteNode(),
      h(
        'button',
        { type: 'button', class: 'btn btn-accent btn-block btn-tall', disabled: !ready || state.busy || off, onclick: startPayment },
        state.busy ? [h('span', { class: 'spinner' }), 'Holding your bay…'] : [B.icon('lock', 'ico-sm'), label]
      ),
      h('p', { class: 'fine light' }, fine),
    ];
  }

  function summaryPaying() {
    const { booking, payment } = state.checkout;
    const demo = payment.mode === 'demo';
    const details = rows([
      ['Vehicle', `${booking.vehicleLabel}, ${booking.plate}`],
      ['Bay', `${booking.bay}, ${booking.zone}`],
      ['When', booking.window],
      ['Total', rupees(payment.amount / 100)],
    ]);
    if (state.expired) {
      return [
        h('h2', { tabindex: '-1' }, 'Your hold has ended'),
        details,
        h('p', { class: 'msg info' }, 'The bay may have been released, so please choose it again. If you were already paying, do not worry: a payment that arrives late is confirmed if the bay is still free, otherwise it is refunded automatically.'),
        h('button', { type: 'button', class: 'btn btn-accent btn-block btn-tall', onclick: startAgain }, 'Start again'),
      ];
    }
    return [
      h('h2', { tabindex: '-1' }, demo ? 'Simulated payment' : 'Complete your payment'),
      demo ? h('p', { class: 'msg info' }, 'This computer has no Razorpay keys, so the payment is only pretended. On the real website, Razorpay’s payment window (UPI, cards and more) opens here.') : null,
      details,
      holdLine(),
      noteNode(),
      h(
        'button',
        { type: 'button', class: 'btn btn-accent btn-block btn-tall', onclick: demo ? payDemo : openCheckout },
        demo ? 'Pay ' + rupees(payment.amount / 100) + ' (simulated)' : 'Open payment window'
      ),
      h('button', { type: 'button', class: 'link-btn', onclick: startAgain }, 'Change my booking'),
    ];
  }

  function summaryConfirming() {
    return [
      h('h2', { tabindex: '-1' }, 'Confirming your payment'),
      h('div', { class: 'working' }, h('span', { class: 'spinner' }), 'Just a moment…'),
      h('p', { class: 'fine light' }, 'Please keep this page open.'),
    ];
  }

  function summaryDone() {
    const b = state.booking;
    const plate = S.normalizePlate(b.plate);
    return [
      h('div', { class: 'confirm-mark' }, B.icon('check', 'tick')),
      h('h2', { tabindex: '-1' }, 'Booking confirmed'),
      h('div', { class: 'stack g8' }, h('p', { class: 'hold-line' }, 'Your bay'), h('p', { class: 'bay-big' }, b.bay), h('p', { class: 'hold-line' }, b.zone)),
      h('div', { class: 'ref-box' }, h('small', null, 'Booking reference'), h('b', null, b.ref)),
      rows([
        ['Vehicle', `${b.vehicleLabel}, ${b.plate}`],
        ['When', b.window],
        ['Paid', rupees(b.amount)],
      ]),
      h('a', { class: 'btn btn-accent btn-block btn-tall', href: '/lookup?plate=' + encodeURIComponent(plate) }, 'Find my booking'),
      h('button', { type: 'button', class: 'btn btn-outline-light btn-block', onclick: startAgain }, 'Book another bay'),
      h('p', { class: 'fine light' }, 'Note your bay number. You can always find this booking again with your vehicle number.'),
    ];
  }

  function summaryProblem(title, text, kind) {
    return [
      h('h2', { tabindex: '-1' }, title),
      h('p', { class: 'msg ' + kind, role: 'alert' }, text),
      state.paymentId ? h('p', { class: 'fine light' }, 'Payment ID: ' + state.paymentId) : null,
      state.stage === 'unsure' ? h('a', { class: 'btn btn-accent btn-block btn-tall', href: '/lookup?plate=' + encodeURIComponent(state.checkoutPlate || '') }, 'Find my booking') : null,
      h('button', { type: 'button', class: 'btn btn-outline-light btn-block', onclick: startAgain }, state.stage === 'unsure' ? 'Back to booking' : 'Choose another time'),
    ];
  }

  function renderSummary() {
    clockNode = null;
    let kids;
    if (!state.cfg && !state.problem) {
      kids = [h('h2', null, 'Your booking'), h('div', { class: 'working', role: 'status' }, h('span', { class: 'spinner' }), 'Loading…')];
    } else if (state.problem) {
      kids = [h('h2', null, 'Booking is not available'), h('p', { class: 'msg err', role: 'alert' }, state.problem), h('button', { type: 'button', class: 'btn btn-accent btn-block', onclick: () => location.reload() }, 'Try again')];
    } else if (state.stage === 'choose') kids = summaryChoose();
    else if (state.stage === 'paying' || state.stage === 'demo') kids = summaryPaying();
    else if (state.stage === 'confirming') kids = summaryConfirming();
    else if (state.stage === 'done') kids = summaryDone();
    else if (state.stage === 'lost') kids = summaryProblem('That bay was not available', state.lostText, 'err');
    else kids = summaryProblem('We are still confirming your payment', state.lostText, 'info');
    els.summary.replaceChildren(...kids.flat().filter(Boolean));
  }

  function setStage(stage) {
    state.stage = stage;
    els.grid.classList.toggle('solo', stage !== 'choose');
    els.main.inert = stage !== 'choose';
    clearInterval(clockTimer);
    clockTimer = stage === 'paying' || stage === 'demo' ? setInterval(tickClock, 1000) : null;
    renderSummary();
  }

  function focusSummary() {
    const heading = els.summary.querySelector('h2');
    if (heading) heading.focus({ preventScroll: false });
  }

  function tickClock() {
    if (!state.checkout) return;
    const left = state.checkout.booking.holdUntil - B.now();
    if (clockNode) clockNode.textContent = B.clock(left);
    if (left <= 0 && !state.expired) {
      state.expired = true;
      renderSummary();
    }
  }

  // ---- Holding the bay and paying ---------------------------------------------------------------------------------------
  async function startPayment() {
    if (state.busy || !state.avail || !state.bay) return;
    const plate = plateCtl.validate();
    if (!plate) {
      state.note = { kind: 'err', text: 'Enter your vehicle number first.' };
      renderSummary();
      els.plate.focus();
      els.plate.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (state.cfg.auth && state.cfg.auth.loginRequired && !state.user) {
      state.note = { kind: 'info', text: 'Please sign in, or create an account, to book this bay. Your choices here are kept.', link: { href: '/login?next=' + encodeURIComponent('/book'), text: 'Sign in or create an account' } };
      renderSummary();
      return;
    }
    state.busy = true;
    state.note = null;
    renderSummary();
    try {
      const res = await B.post('/api/bookings', { vehicle: state.vehicle, plate, date: state.date, time: state.time, hours: state.hours, bay: state.bay });
      state.busy = false;
      state.checkout = res;
      state.checkoutPlate = plate;
      state.expired = false;
      saveCheckout();
      B.remember.set('plate', plate);
      setStage(res.payment.mode === 'razorpay' ? 'paying' : 'demo');
      if (res.payment.mode === 'razorpay') openCheckout();
      else focusSummary();
    } catch (err) {
      state.busy = false;
      bookingFailed(err, plate);
    }
  }

  function bookingFailed(err, plate) {
    state.note = { kind: 'err', text: err.message };
    if (err.code === 'login_required') state.note.link = { href: '/login?next=' + encodeURIComponent('/book'), text: 'Sign in or create an account' };
    if (err.code === 'plate_busy') state.note.link = { href: '/lookup?plate=' + encodeURIComponent(plate), text: 'Open Find my booking' };
    if (err.code === 'bay_taken') state.bay = null;
    if (err.code === 'too_early' || err.code === 'too_late' || err.code === 'bay_taken' || err.code === 'zone_full') {
      buildSlots();
      ensureSelection();
      renderDays();
      renderTimes();
      state.avail = null;
      state.loading = true;
      renderZones();
      renderBays();
      renderSummary();
      const keep = state.note;
      loadAvailability().then(() => {
        state.note = keep;
        if (err.code === 'bay_taken' && state.bay) state.note = { kind: 'info', text: `${err.message} We picked ${state.bay} instead. Please check it before you pay.` };
        renderSummary();
      });
      return;
    }
    renderSummary();
  }

  async function startAgain() {
    const c = state.checkout;
    clearCheckout();
    // Give the held bay back first, and ask which bays are free only after the server has answered. Two requests sent
    // together can arrive in either order, and the list could then show the bay this person just let go of as taken.
    // Nobody waits more than 3 seconds, and a failed release is fine: an unused hold runs out by itself.
    const released = c
      ? Promise.race([
          B.post('/api/bookings/' + encodeURIComponent(c.booking.id) + '/release', {}).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ])
      : null;
    state.booking = null;
    state.note = null;
    state.paymentId = null;
    state.bay = null;
    buildSlots();
    ensureSelection();
    renderDays();
    renderTimes();
    state.avail = null;
    state.loading = true;
    setStage('choose');
    renderZones();
    renderBays();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (released) await released;
    loadAvailability();
  }

  // Razorpay's own script. It is only loaded when someone is about to pay.
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

  async function openCheckout() {
    if (!state.checkout || state.stage !== 'paying') return;
    const { booking, payment } = state.checkout;
    state.note = null;
    try {
      await loadRazorpay();
    } catch (err) {
      state.note = { kind: 'err', text: 'We could not load the payment window. Check your connection, then press “Open payment window”.' };
      renderSummary();
      return;
    }
    let failure = null;
    const checkout = new window.Razorpay({
      key: payment.keyId,
      amount: payment.amount,
      currency: payment.currency,
      name: payment.name,
      description: `${booking.vehicleLabel} bay ${booking.bay}`,
      order_id: payment.orderId,
      theme: { color: '#1b3fd8' },
      handler: (response) => verifyPayment(response),
      modal: {
        confirm_close: true,
        ondismiss: () => {
          if (state.stage !== 'paying') return;
          state.note = failure
            ? { kind: 'err', text: failure + ' You can try again.' }
            : { kind: 'info', text: 'The payment window was closed. Your bay is still held, so you can pay now.' };
          renderSummary();
        },
      },
    });
    checkout.on('payment.failed', (event) => {
      failure = (event && event.error && event.error.description) || 'The payment did not go through.';
    });
    checkout.open();
  }

  // The customer paid. Only the server can say whether that payment is genuine, so we hand it the proof.
  async function verifyPayment(response) {
    const plate = state.checkoutPlate || '';
    const body = {
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature,
    };
    state.paymentId = response.razorpay_payment_id || null;
    clearCheckout();
    setStage('confirming');
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await B.post('/api/payments/verify', body);
        return finish(out.booking);
      } catch (err) {
        last = err;
        if (err.status === 409 && err.code === 'slot_lost') {
          state.lostText = err.message;
          setStage('lost');
          return focusSummary();
        }
        // A rejected request will not get better by repeating it. A lost connection or a server hiccup might.
        if (err.status >= 400 && err.status < 500 && err.status !== 429) break;
        if (attempt < 2) await sleep(1500 * (attempt + 1));
      }
    }
    state.checkoutPlate = plate;
    state.lostText =
      (last && last.status >= 400 && last.status < 500 && last.status !== 429 ? last.message + ' ' : 'We could not confirm your payment just now. ') +
      'Please do not pay again. If you were charged, your booking should appear in Find my booking within about 15 minutes. If it does not, contact us and quote the payment ID below.';
    setStage('unsure');
    focusSummary();
  }

  async function payDemo() {
    if (!state.checkout || state.busy) return;
    const id = state.checkout.booking.id;
    state.checkoutPlate = state.checkoutPlate || state.checkout.booking.plate;
    state.busy = true;
    clearCheckout();
    setStage('confirming');
    try {
      const out = await B.post('/api/payments/demo-confirm', { bookingId: id });
      state.busy = false;
      finish(out.booking);
    } catch (err) {
      state.busy = false;
      if (err.status === 409 && err.code === 'slot_lost') state.lostText = err.message;
      else state.lostText = err.message;
      setStage('lost');
      focusSummary();
    }
  }

  function finish(booking) {
    clearCheckout();
    state.booking = booking;
    B.remember.set('plate', S.normalizePlate(booking.plate));
    setStage('done');
    focusSummary();
  }

  // ---- Start ---------------------------------------------------------------------------------------------------------------
  async function init() {
    let cfg;
    try {
      cfg = await B.getConfig();
    } catch (err) {
      state.problem = err.message;
      renderSummary();
      return;
    }
    state.cfg = cfg;
    state.user = await B.session();
    state.hours = cfg.hoursOptions[0];

    const query = new URLSearchParams(window.location.search);
    if (S.VEHICLES.includes(query.get('vehicle'))) state.vehicle = query.get('vehicle');

    plateCtl = B.plateField(els.plate, els.plateHelp, (norm) => {
      state.plate = norm;
      if (state.stage === 'choose') {
        if (state.note && state.note.text === 'Enter your vehicle number first.') state.note = null;
        renderSummary();
      }
    });
    const given = query.get('plate') || B.remember.get('plate');
    if (given && S.isValidPlate(S.normalizePlate(given))) plateCtl.set(S.formatPlate(S.normalizePlate(given)));

    els.time.addEventListener('change', () => {
      if (state.stage !== 'choose') return;
      state.time = els.time.value;
      availabilityChanged();
    });

    buildSlots();
    ensureSelection();
    renderVehicle();
    renderDays();
    renderTimes();
    renderHours();

    if (cfg.payments.mode === 'razorpay') loadRazorpay().catch(() => {});

    if (restoreCheckout()) {
      state.checkoutPlate = S.normalizePlate(state.checkout.booking.plate);
      setStage(state.checkout.payment.mode === 'razorpay' ? 'paying' : 'demo');
      renderZones();
      renderBays();
      return;
    }

    setStage('choose');
    renderZones();
    renderBays();
    loadAvailability();
  }

  renderSummary();
  init();
})();
