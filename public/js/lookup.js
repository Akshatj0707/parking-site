/*
 * Find my booking: type a vehicle number, see its bay and time. Nothing about money is ever shown here.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h } = B;
  const $ = (id) => document.getElementById(id);

  const form = $('lookup-form');
  const input = $('plate');
  const go = $('go');
  const out = $('results');
  const plate = B.plateField(input, $('plate-help'));

  let seq = 0;
  let timings = []; // { node, booking } so the "starts in" text can keep up with the clock

  function timingText(b) {
    const t = B.now();
    return b.startMs <= t ? 'Ends in ' + B.duration(b.endMs - t) : 'Starts in ' + B.duration(b.startMs - t);
  }

  function fact(label, value) {
    return h('div', null, h('dt', null, label), h('dd', null, value));
  }

  function card(b) {
    const timing = h('dd', null, timingText(b));
    timings.push({ node: timing, booking: b });
    const when = h('div', null, h('dt', null, 'Time left'), timing);
    return h(
      'article',
      { class: 'result' },
      h('div', { class: 'result-head' }, h('h2', null, b.plate), h('span', { class: 'state-pill ' + b.state }, b.state === 'active' ? 'On now' : 'Upcoming')),
      h('div', { class: 'stack g8' }, h('p', { class: 'bay-big' }, b.bay), h('p', { class: 'fine light' }, `${b.zone}, ${b.vehicleLabel} bay`)),
      h('dl', { class: 'facts' }, fact('When', b.window), fact('Length', b.hours + (b.hours === 1 ? ' hour' : ' hours')), fact('Booking reference', b.ref), when)
    );
  }

  function empty(plateText, plateNorm) {
    return h(
      'div',
      { class: 'empty-card' },
      h('h2', null, 'No current booking for ' + plateText),
      h('p', { class: 'muted' }, 'We only show bookings that have not ended yet. If you have just paid, wait a minute and search again. Check the vehicle number too: a different number is a different booking.'),
      h('a', { class: 'btn btn-navy', href: '/book?plate=' + encodeURIComponent(plateNorm) }, 'Book a bay')
    );
  }

  async function search(norm) {
    const mine = ++seq;
    go.disabled = true;
    timings = [];
    out.replaceChildren(h('div', { class: 'working muted', role: 'status' }, h('span', { class: 'spinner' }), 'Looking…'));
    try {
      await B.getConfig(); // so that "now" follows the server's clock
      const data = await B.api('/api/bookings/lookup?plate=' + encodeURIComponent(norm));
      if (mine !== seq) return;
      timings = [];
      out.replaceChildren(...(data.bookings.length ? data.bookings.map(card) : [empty(data.plate, norm)]));
      try {
        window.history.replaceState(null, '', '?plate=' + encodeURIComponent(norm));
      } catch (err) {
        // not important
      }
      B.remember.set('plate', norm);
    } catch (err) {
      if (mine !== seq) return;
      out.replaceChildren(h('p', { class: 'msg err', role: 'alert' }, err.message));
    } finally {
      if (mine === seq) go.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const norm = plate.validate();
    if (!norm) {
      out.replaceChildren();
      input.focus();
      return;
    }
    search(norm);
  });

  setInterval(() => {
    for (const t of timings) t.node.textContent = timingText(t.booking);
  }, 30 * 1000);

  const query = new URLSearchParams(window.location.search);
  const given = S.normalizePlate(query.get('plate') || '');
  if (S.isValidPlate(given)) {
    plate.set(S.formatPlate(given));
    search(given);
  } else {
    const saved = S.normalizePlate(B.remember.get('plate') || '');
    if (S.isValidPlate(saved)) plate.set(S.formatPlate(saved));
  }
})();
