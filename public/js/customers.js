/*
 * The admin's list of customer accounts: who they are, how much they have booked and spent. Never a password.
 * Text goes on the page as text.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees, api } = B;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['q', 'sort'];
  const DEFAULTS = { q: '', sort: 'spent' };
  let page = 1;
  let off = 330;
  let seq = 0;

  const day = (ms) => (ms ? S.formatDate(ms, off) : '–');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const tile = (label, value, note) => h('div', { class: 'tile' }, h('p', { class: 'k' }, label), h('p', { class: 'n' }, value), h('p', { class: 'note' }, note));

  function readForm() {
    const v = {};
    for (const f of FIELDS) v[f] = $('f-' + f).value.trim();
    return v;
  }

  function table(rows) {
    if (!rows.length) return h('p', { class: 'muted' }, 'No customers match.');
    const heads = ['Customer', 'Joined', 'Paid bookings', 'Spent', 'Refunded', 'Last parking', 'Next parking', ''];
    return h(
      'table',
      { class: 'table' },
      h('caption', { class: 'sr-only' }, 'Customers'),
      h('thead', null, h('tr', null, heads.map((t) => h('th', { scope: 'col', class: t === 'Paid bookings' || t === 'Spent' || t === 'Refunded' ? 'num' : null }, t)))),
      h(
        'tbody',
        null,
        rows.map((r) =>
          h(
            'tr',
            null,
            h('td', null, r.name, h('span', { class: 'sub' }, r.email)),
            h('td', null, day(r.joinedAt)),
            h('td', { class: 'num' }, String(r.bookings)),
            h('td', { class: 'num' }, rupees(r.spent)),
            h('td', { class: 'num' }, r.refunded ? rupees(r.refunded) : '–'),
            h('td', null, day(r.lastBookingAt)),
            h('td', null, day(r.nextBookingAt)),
            h('td', null, h('a', { class: 'btn btn-outline btn-sm', href: '/bookings?status=all&q=' + encodeURIComponent(r.email) }, 'Their bookings'))
          )
        )
      )
    );
  }

  function pager(d) {
    const go = (n) => () => {
      page = n;
      load();
    };
    $('pager').replaceChildren(
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: d.page <= 1, onclick: go(d.page - 1) }, 'Previous'),
      h('span', { class: 'fine' }, `Page ${d.page} of ${d.pages}`),
      h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: d.page >= d.pages, onclick: go(d.page + 1) }, 'Next')
    );
    $('pager').hidden = d.pages <= 1;
  }

  async function load() {
    const mine = ++seq;
    const v = readForm();
    const p = new URLSearchParams();
    for (const f of FIELDS) if (v[f] && v[f] !== DEFAULTS[f]) p.set(f, v[f]);
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    try {
      const d = await api('/api/dashboard/customers?' + (qs ? qs + '&' : '') + 'page=' + page);
      if (mine !== seq) return;
      off = d.utcOffsetMinutes;
      page = d.page;
      $('updated').textContent = 'Updated ' + S.formatTime(d.serverTime, d.utcOffsetMinutes);
      $('totals').textContent = plural(d.total, 'customer') + ' shown';
      $('list').replaceChildren(table(d.rows));
      pager(d);
    } catch (err) {
      if (mine !== seq) return;
      $('updated').textContent = 'Could not load';
      $('notice').replaceChildren(h('div', { class: 'banner bad' }, err.status === 403 ? 'This page is only for the admin. ' + err.message : err.message));
    }
  }

  async function tiles() {
    try {
      const o = await api('/api/dashboard/overview');
      const c = o.customers;
      $('cust-tiles').replaceChildren(
        tile('Customer accounts', String(c.registered), `${c.newLast30Days} new in the last 30 days`),
        tile('Have booked', String(c.withBookings), 'At least one paid booking'),
        tile('Repeat customers', String(c.repeat), `${c.repeatRate}% of those who booked`),
        tile('Collected from them', rupees(o.topCustomers.reduce((n, t) => n + t.spent, 0)), 'Top 5 customers together')
      );
    } catch (err) {
      // the table below shows the error
    }
  }

  const params = new URLSearchParams(location.search);
  for (const f of FIELDS) $('f-' + f).value = params.has(f) ? params.get(f) : DEFAULTS[f];
  $('filters').addEventListener('submit', (e) => {
    e.preventDefault();
    page = 1;
    load();
  });
  $('f-sort').addEventListener('change', () => {
    page = 1;
    load();
  });
  $('f-reset').addEventListener('click', () => {
    for (const f of FIELDS) $('f-' + f).value = DEFAULTS[f];
    page = 1;
    load();
  });
  tiles();
  load();
})();
