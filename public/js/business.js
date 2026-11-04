/*
 * The owner's business overview: money, the lot, customers, best weekdays and months, the payment connection, and who can do
 * what. Every number comes from the server's real bookings; nothing here is made up. Text is put on the page as text.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees, api } = B;
  const $ = (id) => document.getElementById(id);

  const tile = (cls, label, value, note, text) =>
    h('div', { class: 'tile ' + cls }, h('p', { class: 'k' }, label), h('p', { class: 'n' + (text ? ' n-text' : '') }, value), h('p', { class: 'note' }, note));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function showError(err) {
    $('updated').textContent = 'Could not load';
    $('notice').replaceChildren(h('div', { class: 'banner bad' }, err.status === 403 ? 'This page is only for the admin. ' + err.message : err.message));
  }

  function bars(list, key, labelOf, valueOf, subOf) {
    const max = Math.max(...list.map((x) => x[key]), 0);
    const best = max > 0 ? list.findIndex((x) => x[key] === max) : -1;
    return list.map((x, i) =>
      h(
        'li',
        null,
        h('span', { class: 'lbl' }, labelOf(x)),
        h('span', { class: 'track' }, h('span', { class: 'fill' + (i === best ? ' best' : ''), style: `width:${max ? Math.max(1, Math.round((x[key] / max) * 100)) : 0}%` })),
        h('span', { class: 'val' }, valueOf(x), ' ', h('small', null, subOf(x)))
      )
    );
  }

  function draw(o) {
    $('updated').textContent = 'Updated ' + S.formatTime(o.serverTime, o.utcOffsetMinutes);

    const c = o.collection;
    const r = o.refunded;
    $('money-tiles').replaceChildren(
      tile('tile-dark', 'Today', rupees(c.today), `${plural(o.bookings.paidToday, 'payment')} today${r.today ? ', ' + rupees(r.today) + ' refunded' : ''}`),
      tile('', 'Last 7 days', rupees(c.last7), `Yesterday ${rupees(c.yesterday)}${r.last7 ? ', ' + rupees(r.last7) + ' refunded' : ''}`),
      tile('', 'This month', rupees(c.thisMonth), `Last month ${rupees(c.lastMonth)}${r.thisMonth ? ', ' + rupees(r.thisMonth) + ' refunded this month' : ''}`),
      tile('', 'All time', rupees(c.allTime), `${plural(o.bookings.paid, 'paid booking')}${r.allTime ? ', ' + rupees(r.allTime) + ' refunded' : ''}`)
    );

    const oc = o.occupancy;
    $('ops-tiles').replaceChildren(
      tile('', 'Lot in use now', oc.percent + '%', `Cars ${oc.car.inUse} of ${oc.car.total}, two-wheelers ${oc.bike.inUse} of ${oc.bike.total}`),
      tile('', 'Coming up', String(o.bookings.upcoming), 'Paid bookings that have not started yet'),
      tile('', 'Average booking', rupees(o.average.booking), `${o.average.hours} hours on average`),
      tile('', 'Cancelled or refunded', o.bookings.cancellationRate + '%', plural(o.bookings.cancelledOrRefunded, 'booking')),
      tile('', 'Customers', String(o.customers.registered), `${o.customers.repeat} repeat (${o.customers.repeatRate}% of those who booked), ${o.customers.newLast30Days} new in 30 days`)
    );

    const peak = [];
    if (o.peak) {
      peak.push(h('p', { class: 'tile-line' }, h('b', null, 'Busiest hour: '), o.peak.label));
      const atOnce = Math.max(1, Math.round(o.peak.parked));
      peak.push(h('p', { class: 'muted' }, `About ${atOnce} ${atOnce === 1 ? 'vehicle' : 'vehicles'} parked at once on an average day (${o.peak.utilisation}% of all ${o.bays.total} bays), over the last 30 days.`));
      if (o.peak.window.to - o.peak.window.from > 1) peak.push(h('p', { class: 'muted' }, `The busy stretch is about ${o.peak.window.label}.`));
      if (o.mostArrivals) peak.push(h('p', { class: 'muted' }, `Most vehicles arrive in ${o.mostArrivals.label}, about ${o.mostArrivals.perDay} a day.`));
    } else {
      peak.push(h('p', { class: 'muted' }, 'Nothing to show yet. Once customers have booked and paid, the busiest hour appears here.'));
    }
    if (o.bestWeekday) peak.push(h('p', { class: 'muted' }, `Best weekday: ${o.bestWeekday.label}, ${rupees(o.bestWeekday.collection)} from ${plural(o.bestWeekday.bookings, 'booking')}.`));
    $('peak').replaceChildren(...peak);

    const p = o.payments;
    const row = (name, text, cls) => h('li', null, h('span', null, name), h('span', { class: cls }, text));
    $('pay-status').replaceChildren(
      row('Taking payments', p.acceptingPayments ? 'Yes' : 'No: booking is switched off', p.acceptingPayments ? 'yes' : 'no'),
      row('Razorpay', p.live ? 'Live: real money' : p.keysSet ? 'Test keys: no real money' : 'Not connected', p.live ? 'yes' : p.keysSet ? 'maybe' : 'no'),
      row('Webhook (a safety net for payments)', p.webhookSet ? 'Set up' : 'Not set up', p.webhookSet ? 'yes' : 'maybe'),
      row('Bookings and accounts are saved', p.storageKept ? 'Safely' : 'Only temporarily', p.storageKept ? 'yes' : 'no')
    );
    $('notice').replaceChildren(...p.problems.map((x) => h('div', { class: 'banner ' + (x.level === 'bad' ? 'bad' : x.level === 'warn' ? 'warn' : 'info') }, x.text)));

    // Monday first
    const order = [1, 2, 3, 4, 5, 6, 0];
    $('weekdays').replaceChildren(...bars(order.map((i) => o.weekdays[i]), 'collection', (x) => x.label, (x) => rupees(x.collection), (x) => plural(x.bookings, 'booking')));
    $('months').replaceChildren(...bars(o.months, 'collection', (x) => x.label.replace(/ \d{4}$/, ' ' + x.label.slice(-2)), (x) => rupees(x.collection), (x) => plural(x.bookings, 'booking')));

    $('top').replaceChildren(
      o.topCustomers.length
        ? h(
            'table',
            { class: 'table', style: 'min-width:0' },
            h('caption', { class: 'sr-only' }, 'Customers who spent the most'),
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Customer'), h('th', { scope: 'col', class: 'num' }, 'Bookings'), h('th', { scope: 'col', class: 'num' }, 'Spent'))),
            h('tbody', null, o.topCustomers.map((t) => h('tr', null, h('td', null, t.name, h('span', { class: 'sub' }, t.email)), h('td', { class: 'num' }, String(t.bookings)), h('td', { class: 'num' }, rupees(t.spent)))))
          )
        : h('p', { class: 'muted' }, 'No customer has booked yet.')
    );
  }

  function drawRoles(m) {
    const yes = h('span', { class: 'tick-yes', 'aria-label': 'Allowed' }, '✓');
    $('roles').replaceChildren(
      h(
        'table',
        { class: 'table role-table' },
        h('caption', { class: 'sr-only' }, 'What each role is allowed to do'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Permission'), m.roles.map((r) => h('th', { scope: 'col', class: 'tick' }, r.label)))),
        h(
          'tbody',
          null,
          m.permissions.map((p) =>
            h('tr', null, h('td', null, p.text), m.roles.map((r) => h('td', { class: 'tick' }, p.roles.includes(r.id) ? yes.cloneNode(true) : h('span', { class: 'tick-no', 'aria-label': 'Not allowed' }, '–'))))
          )
        )
      ),
      h('p', { class: 'fine' }, m.roles.map((r) => `${r.label}: ${r.summary}`).join(' '))
    );
  }

  api('/api/dashboard/roles').then(drawRoles, () => {});
  B.poll(async () => {
    try {
      draw(await api('/api/dashboard/overview'));
    } catch (err) {
      showError(err);
    }
  }, 30000);
})();
