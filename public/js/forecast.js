/*
 * The "next 7 days" part of the analytics page: the demand forecast, how far off it has been, and price ideas.
 * The numbers come from GET /api/dashboard/forecast. Everything from the server goes on the page as text.
 * Nothing here can change a price.
 */
(function () {
  'use strict';

  const { h, api, poll, rupees, lotTime } = window.Bayfind;
  const $ = (id) => document.getElementById(id);

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const percent = (fraction) => Math.round(fraction * 100) + '%';
  const CONFIDENCE = {
    low: ['Low confidence', 'cancelled'],
    medium: ['Medium confidence', 'refund_pending'],
    high: ['High confidence', 'paid'],
  };

  // A bar for "how full are the bays at the busiest hour", with the number written beside it.
  function meter(value, label) {
    return h('div', { class: 'fc-meter', role: 'img', 'aria-label': label },
      h('span', { class: 'fc-meter-bar' }, h('span', { class: 'fc-meter-fill', style: `width:${Math.min(100, Math.max(0, value))}%` })),
      h('span', { class: 'fc-meter-n' }, Math.round(value) + '%'));
  }

  function qualityText(d) {
    const a = d.accuracy;
    const s = a.series.arrivals;
    if (!a.days || s.wape === null) return 'There are not enough finished days to check how good the forecast is yet.';
    const better = s.naiveWape !== null && s.wape < s.naiveWape;
    return `Checked on the last ${plural(a.days, 'finished day')}: the number of bookings a day was off by about ${percent(s.wape)} (about ${Math.round(s.mae)} bookings). ` +
      (s.naiveWape === null ? '' : `A plain “same as last week” guess was off by ${percent(s.naiveWape)}, so this method is ${better ? 'better' : 'not better'}.`);
  }

  function accuracyTable(d) {
    const rows = [
      ['arrivals', 'Bookings a day', 'bookings'],
      ['bayHours', 'Bay-hours booked a day', 'bay-hours'],
      ['peakCar', 'Cars: how full at the busiest hour', 'points'],
      ['peakBike', 'Two-wheelers: how full at the busiest hour', 'points'],
    ];
    const cell = (v) => (v === null || v === undefined ? '–' : percent(v));
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, 'How far off the forecast was on each of the last finished days'),
        h('thead', null, h('tr', null, ['What is forecast', 'Average miss', 'Off by (share of the real total)', 'Same as last week, off by'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, ...rows.map(([key, name, unit]) => {
          const s = d.accuracy.series[key] || {};
          return h('tr', null,
            h('th', { scope: 'row' }, name),
            h('td', null, s.mae === null || s.mae === undefined ? '–' : `${s.mae} ${unit === 'points' ? 'percentage points' : unit}`),
            h('td', null, cell(s.wape)),
            h('td', null, cell(s.naiveWape)));
        }))));
  }

  function daysTable(d) {
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, 'Forecast for the next seven days'),
        h('thead', null, h('tr', null, ['Day', 'Bookings expected', 'Already booked', 'Cars, busiest hour', 'Two-wheelers, busiest hour'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, ...d.days.map((r) =>
          h('tr', null,
            h('th', { scope: 'row' }, r.label, h('span', { class: 'sub' }, r.dayType === 'weekend' ? 'Weekend rate' : 'Weekday rate')),
            h('td', null, String(Math.round(r.arrivals.expected)) + (r.arrivals.floored ? ' (at least)' : '')),
            h('td', null, String(Math.round(r.arrivals.bookedSoFar))),
            h('td', null, meter(r.car.peakPercent, `Cars ${Math.round(r.car.peakPercent)} percent full`), r.car.peakHour ? h('span', { class: 'sub' }, r.car.peakHour.label) : null),
            h('td', null, meter(r.bike.peakPercent, `Two-wheelers ${Math.round(r.bike.peakPercent)} percent full`), r.bike.peakHour ? h('span', { class: 'sub' }, r.bike.peakHour.label) : null))))));
  }

  function suggestionsBlock(d) {
    const kids = [h('h3', { class: 'fc-sub' }, 'Price ideas')];
    kids.push(h('p', { class: 'fine' }, 'These are only ideas. The website never changes a price by itself. If you like one, change the rate in the RATE_ settings (see the README) before that day.'));
    if (d.suggestions.length) {
      kids.push(h('ul', { class: 'plain-list fc-ideas' }, ...d.suggestions.map((x) =>
        h('li', null, h('span', { class: 'badge ' + (x.action === 'raise' ? 'refund_pending' : 'refunded') }, x.action === 'raise' ? 'Higher rate' : 'Offer'), ' ', x.text))));
    } else if (d.confidence !== 'low') {
      kids.push(h('p', { class: 'muted' }, `No price change is suggested for the next ${d.horizon} days. A higher rate is only suggested when a busiest hour is expected to be ${d.settings.highPercent}% full or more.`));
    }
    for (const note of d.notes) kids.push(h('p', { class: 'msg info', role: 'note' }, note));
    return h('div', { class: 'stack g12' }, ...kids);
  }

  function draw(d) {
    const body = $('fc-body');
    if (!d.ready) {
      $('fc-note').textContent = '';
      body.replaceChildren(h('p', { class: 'muted' }, d.reason));
      return;
    }
    const [word, cls] = CONFIDENCE[d.confidence];
    $('fc-note').textContent = `Updated ${lotTime(d.serverTime, d)} (lot time)`;
    body.replaceChildren(
      ...[
      h('p', null, h('span', { class: 'badge ' + cls }, word), ' ',
        `Based on ${plural(d.history.days, 'day')} of bookings. ` + qualityText(d)),
      d.sample.present ? h('p', { class: 'msg info', role: 'note' }, 'The numbers include sample bookings, which are made up. Real bookings will change them.') : null,
      daysTable(d),
      suggestionsBlock(d),
      h('details', { class: 'an-details' },
        h('summary', null, 'How good is the forecast, in detail'),
        accuracyTable(d),
        h('p', { class: 'fine' }, 'Each of the last finished days was forecast again using only the days before it, then compared with what really happened.'))
      ].filter(Boolean) // replaceChildren would write a null as the word "null"
    );
  }

  async function load() {
    try {
      draw(await api('/api/dashboard/forecast'));
    } catch (err) {
      $('fc-body').replaceChildren(h('p', { class: 'msg err', role: 'alert' }, err.message));
    }
  }

  if ($('fc-body')) poll(load, 60 * 1000);
})();
