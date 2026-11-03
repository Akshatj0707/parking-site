/*
 * The operator's analytics page: the money collected on a day, and the busiest hours.
 * The numbers come from GET /api/dashboard/analytics. Charts are drawn here as SVG; everything from the server is put
 * on the page as text, never as HTML.
 */
(function () {
  'use strict';

  const { h, api, post, rupees, poll, lotTime } = window.Bayfind;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const state = { days: 14, date: '', metric: 'parked', vehicle: 'total', scope: 'average', data: null };

  // ---- Small things -------------------------------------------------------------------------------------------
  function svg(tag, attrs, ...kids) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return node;
  }

  const hourName = (hh) => (hh % 12 || 12) + (hh < 12 ? ' am' : ' pm');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const oneDecimal = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const rupeesShort = (n) => (n >= 1000 ? '₹' + oneDecimal(Math.round(n / 100) / 10) + 'k' : '₹' + Math.round(n));

  // A round number to end the vertical axis on, so the gridlines fall on easy values.
  function niceMax(max) {
    if (!(max > 0)) return 4;
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * mag >= max) return step * mag;
    return 10 * mag;
  }

  // A row of buttons of which one is pressed.
  function segmented(container, options, current, onPick) {
    // keep the keyboard focus on the same button after the buttons are redrawn
    const at = container.contains(document.activeElement) ? Array.prototype.indexOf.call(container.children, document.activeElement) : -1;
    container.replaceChildren(
      ...options.map(([value, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(value === current), onclick: () => onPick(value) }, label)
      )
    );
    if (at >= 0 && container.children[at]) container.children[at].focus();
  }

  // ---- A bar chart -----------------------------------------------------------------------------------------------
  // values: numbers; labels: the text under the bars; titles: what a bar says when hovered; highlight: the index to colour
  function barChart({ values, labels, titles, labelEvery, highlight, aria, formatTick, formatBar }) {
    const W = 720;
    const H = 290;
    const L = 56;
    const R = 10;
    const T = 26;
    const Bm = 42;
    const plotW = W - L - R;
    const plotH = H - T - Bm;
    const top = niceMax(Math.max(0, ...values));
    const slot = plotW / values.length;
    const bw = Math.max(3, slot * 0.7);
    const node = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria, focusable: 'false' });

    for (let i = 0; i <= 4; i++) {
      const value = (top * i) / 4;
      const y = T + plotH - (value / top) * plotH;
      node.append(svg('line', { class: i === 0 ? 'base' : 'grid', x1: L, x2: W - R, y1: y, y2: y }));
      node.append(svg('text', { class: 'tick tick-y', x: L - 8, y: y + 4 }, formatTick(value)));
    }
    values.forEach((value, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const height = (value / top) * plotH;
      node.append(svg('rect', { class: 'bar' + (i === highlight ? ' peak' : ''), x, y: T + plotH - height, width: bw, height: Math.max(value > 0 ? 1.5 : 0, height), rx: 2 }, svg('title', null, titles[i])));
      if (i % labelEvery === 0) node.append(svg('text', { class: 'tick tick-x', x: x + bw / 2, y: H - 18 }, labels[i]));
    });
    if (highlight >= 0 && values[highlight] > 0) {
      const x = L + highlight * slot + slot / 2;
      const y = T + plotH - (values[highlight] / top) * plotH - 7;
      node.append(svg('text', { class: 'bar-label', x: Math.min(Math.max(x, L + 24), W - R - 24), y: Math.max(y, 14) }, formatBar(values[highlight])));
    }
    if (!values.some((v) => v > 0)) node.append(svg('text', { class: 'empty', x: W / 2, y: T + plotH / 2 }, 'No paid bookings to show yet'));
    return node;
  }

  // ---- Drawing the page ------------------------------------------------------------------------------------------
  function makeTile(extra, label, value, note) {
    return h('div', { class: 'tile ' + extra }, h('p', { class: 'k' }, label), h('p', { class: 'n' }, value), h('p', { class: 'note' }, note));
  }

  function drawTiles(d) {
    const peak = d.peak;
    const dayPeak = d.day.peak;
    const money = d.day;
    const tiles = [
      makeTile('tile-dark', `Collected on ${money.label}`, rupees(money.collection),
        `${plural(money.payments, 'payment')}${money.payments ? ', ' + rupees(money.average) + ' on average' : ''}${money.refunded ? '. ' + rupees(money.refunded) + ' was refunded and is already taken out' : ''}`),
      makeTile('', `Busiest hour, average day`, peak ? hourName(peak.hour) : '–',
        peak ? `${peak.label}: about ${Math.max(1, Math.round(peak.parked))} parked at once (${peak.utilisation}% of ${d.bays.total} bays)` : 'No bookings in this period yet'),
      makeTile('', `Busiest hour on ${money.label}`, dayPeak ? hourName(dayPeak.hour) : '–',
        dayPeak ? `${dayPeak.label}: ${Math.max(1, Math.round(dayPeak.parked))} parked at once` : 'No parked vehicles that day'),
      makeTile('', `Last ${d.days} days`, rupees(d.totals.collection),
        `${plural(d.totals.payments, 'payment')}${d.totals.bestDay ? '. Best day: ' + d.totals.bestDay.label + ', ' + rupees(d.totals.bestDay.collection) : ''}`),
    ];
    $('an-tiles').replaceChildren(...tiles);
  }

  function pickHours(d) {
    const rows = state.scope === 'day' ? d.dayHours : d.hours;
    const vehicle = state.vehicle;
    return rows.map((r) => ({ hour: r.hour, label: r.label, value: state.metric === 'arrivals' ? r.arrivals[vehicle] : r.parked[vehicle], row: r }));
  }

  const VEHICLE_WORD = { total: 'vehicles', car: 'cars', bike: 'two-wheelers' };

  function drawHours(d) {
    const rows = pickHours(d);
    const values = rows.map((r) => r.value);
    const best = Math.max(0, ...values);
    const peakIndex = best > 0 ? values.indexOf(best) : -1;
    const scopeText = state.scope === 'day' ? 'on ' + d.day.label : `on an average day of the last ${d.days} days`;
    const what = state.metric === 'arrivals' ? 'arriving' : 'parked at once';
    $('hours-note').textContent = `${VEHICLE_WORD[state.vehicle][0].toUpperCase() + VEHICLE_WORD[state.vehicle].slice(1)} ${what}, ${scopeText}`;
    const aria = peakIndex >= 0
      ? `Bar chart of ${VEHICLE_WORD[state.vehicle]} ${what} in each hour of the day, ${scopeText}. The busiest hour is ${rows[peakIndex].label} with ${oneDecimal(best)}.`
      : 'Bar chart of the busy hours. There are no paid bookings to show yet.';
    $('chart-hours').replaceChildren(
      barChart({
        values,
        labels: rows.map((r) => hourName(r.hour)),
        titles: rows.map((r) => `${r.label}: ${oneDecimal(r.value)} ${VEHICLE_WORD[state.vehicle]} ${what}`),
        labelEvery: 3,
        highlight: peakIndex,
        aria,
        formatTick: (v) => oneDecimal(Math.round(v * 10) / 10),
        formatBar: (v) => `Peak ${oneDecimal(v)}`,
      })
    );

    const head = ['Hour', 'Cars parked', 'Two-wheelers parked', 'All parked', 'Arrivals', 'Share of bays'];
    const source = state.scope === 'day' ? d.dayHours : d.hours;
    const peakHour = peakIndex >= 0 ? rows[peakIndex].hour : -1;
    $('hours-table').replaceChildren(
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ...head.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, ...source.map((r) =>
          h('tr', { class: r.hour === peakHour ? 'an-peak-row' : null },
            h('th', { scope: 'row' }, r.label + (r.hour === peakHour ? ' (busiest)' : '')),
            h('td', null, oneDecimal(r.parked.car)),
            h('td', null, oneDecimal(r.parked.bike)),
            h('td', null, oneDecimal(r.parked.total)),
            h('td', null, oneDecimal(r.arrivals.total)),
            h('td', null, r.utilisation + '%'))))
      )
    );
  }

  function drawDaily(d) {
    const values = d.daily.map((x) => x.collection);
    const best = Math.max(0, ...values);
    const focusIndex = values.length - 1;
    $('daily-note').textContent = `${d.daily[0].label} to ${d.daily[focusIndex].label}. The yellow bar is ${d.day.label}.`;
    const labelEvery = values.length <= 14 ? 1 : values.length <= 30 ? 3 : 10;
    $('chart-daily').replaceChildren(
      barChart({
        values,
        labels: d.daily.map((x) => x.label.slice(4)),
        titles: d.daily.map((x) => `${x.label}: ${rupees(x.collection)} from ${plural(x.payments, 'payment')}`),
        labelEvery,
        highlight: best > 0 ? focusIndex : -1,
        aria: `Bar chart of the money collected on each of the last ${d.days} days. ${d.day.label}: ${rupees(d.day.collection)}.`,
        formatTick: (v) => rupeesShort(v),
        formatBar: (v) => rupees(v),
      })
    );
  }

  function drawSplit(d) {
    const ranges = [
      ['Last ' + d.days + ' days', d.vehicles],
      [d.day.label, d.day.vehicles],
    ];
    $('split').replaceChildren(
      ...ranges.map(([title, v]) => {
        const total = v.car.collection + v.bike.collection;
        const carShare = total ? (v.car.collection / total) * 100 : 0;
        return h('div', { class: 'stack g8' },
          h('p', { class: 'split-title' }, title + (total ? ': ' + rupees(total) : '')),
          total
            ? h('div', { class: 'split', role: 'img', 'aria-label': `Cars ${Math.round(carShare)} percent, two-wheelers ${Math.round(100 - carShare)} percent of the money` },
                h('span', { class: 'car', style: `width:${carShare}%` }), h('span', { class: 'bike', style: `width:${100 - carShare}%` }))
            : h('p', { class: 'muted' }, 'No payments.'),
          total
            ? h('ul', { class: 'legend' },
                h('li', null, h('span', { class: 'swatch car' }), `Cars: ${rupees(v.car.collection)} from ${plural(v.car.payments, 'payment')} (${Math.round(carShare)}%)`),
                h('li', null, h('span', { class: 'swatch bike' }), `Two-wheelers: ${rupees(v.bike.collection)} from ${plural(v.bike.payments, 'payment')} (${Math.round(100 - carShare)}%)`))
            : null);
      })
    );
  }

  function drawSample(d) {
    const panel = $('sample-panel');
    const testMode = d.paymentMode === 'demo';
    panel.hidden = !(testMode || d.sample.present);
    if (panel.hidden) return;
    $('sample-text').textContent = d.sample.present
      ? `${plural(d.sample.count, 'sample booking')} are included in the numbers above. They are made-up bookings for showing this page, not real customers, and they are all in the past so they never block a bay.`
      : 'Nothing has been booked yet. In test mode you can add about two weeks of made-up bookings (all in the past) to see how the charts look. They are marked as samples and you can remove them at any time.';
    const buttons = [];
    if (testMode) buttons.push(h('button', { class: 'btn btn-navy btn-sm', type: 'button', onclick: () => sample('add') }, d.sample.present ? 'Make new sample bookings' : 'Add sample bookings'));
    if (d.sample.present) buttons.push(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => sample('remove') }, 'Remove sample bookings'));
    $('sample-buttons').replaceChildren(...buttons);
  }

  async function sample(action) {
    $('sample-buttons').querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await post('/api/dashboard/sample-data', { action });
      await load();
    } catch (err) {
      showNotice(err.message, 'err');
      await load().catch(() => {});
    }
  }

  function showNotice(text, kind) {
    $('notice').replaceChildren(text ? h('p', { class: 'msg ' + (kind || 'info'), role: kind === 'err' ? 'alert' : 'status' }, text) : '');
  }

  function draw(d) {
    state.data = d;
    const input = $('an-date');
    input.max = d.today;
    input.value = d.date;
    segmented($('an-range'), [[7, '7 days'], [14, '14 days'], [30, '30 days'], [90, '90 days']], d.days, (v) => {
      state.days = v;
      load();
    });
    segmented($('an-metric'), [['parked', 'Vehicles parked'], ['arrivals', 'Arrivals']], state.metric, (v) => {
      state.metric = v;
      draw(state.data);
    });
    segmented($('an-vehicle'), [['total', 'All'], ['car', 'Cars'], ['bike', 'Two-wheelers']], state.vehicle, (v) => {
      state.vehicle = v;
      draw(state.data);
    });
    segmented($('an-scope'), [['average', `Average of ${d.days} days`], ['day', 'Only ' + d.day.label]], state.scope, (v) => {
      state.scope = v;
      draw(state.data);
    });
    $('updated').textContent = 'Updated ' + lotTime(d.serverTime, d) + ' (lot time)';
    drawTiles(d);
    drawHours(d);
    drawDaily(d);
    drawSplit(d);
    $('insights').replaceChildren(...d.insights.map((text) => h('li', null, text)));
    drawSample(d);
    const empty = d.totals.payments === 0;
    showNotice(empty ? 'There are no paid bookings in this period yet, so the charts are empty.' + (d.paymentMode === 'demo' ? ' You can add sample bookings at the bottom of this page.' : '') : '', 'info');
  }

  async function load() {
    const query = new URLSearchParams({ days: String(state.days) });
    if (state.date) query.set('date', state.date);
    try {
      draw(await api('/api/dashboard/analytics?' + query));
    } catch (err) {
      $('updated').textContent = 'Not updated';
      $('notice').replaceChildren(
        h('div', { class: 'msg err', role: 'alert' }, err.message + ' ', h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: load }, 'Try again'))
      );
    }
  }

  $('an-date').addEventListener('change', (event) => {
    // choosing today means "follow today", so the page still shows the right day after midnight
    state.date = state.data && event.target.value === state.data.today ? '' : event.target.value;
    load();
  });

  poll(load, 60 * 1000);
})();
