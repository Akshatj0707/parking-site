/*
 * The admin's list of every booking: search, filters, pages, a spreadsheet download, and cancel-and-refund.
 * The server does the filtering (and the cancelling); this page only asks and shows. Text goes on the page as text.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees, api, post } = B;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['q', 'status', 'vehicle', 'when', 'from', 'to', 'sort'];
  const DEFAULTS = { q: '', status: 'booked', vehicle: 'all', when: 'all', from: '', to: '', sort: 'newest' };

  let page = 1;
  let off = 330;
  let seq = 0;
  let canRefund = false; // an official sees every booking but cannot cancel or refund (the server refuses it as well)
  const ready = B.can('bookings:cancel-refund').then((yes) => {
    canRefund = yes;
  });

  const when = (ms) => (ms ? `${S.formatDate(ms, off)}, ${S.formatTime(ms, off)}` : '–');
  const shownId = (id) => (id ? String(id).replace(/^demo_/, 'test_') : '–');

  function statusOf(r) {
    if (r.status === 'paid') return [r.state === 'active' ? 'Paid, parked now' : r.state === 'ended' ? 'Paid, over' : 'Paid, coming up', 'paid'];
    if (r.status === 'refunded') return [r.cancelledByOperator ? 'Cancelled, refunded' : 'Refunded', 'refunded'];
    if (r.status === 'refund_pending') return ['Refund sending', 'refund_pending'];
    if (r.status === 'refund_failed') return ['Refund failed', 'refund_failed'];
    if (r.status === 'cancelled') return [r.cancelledByOperator ? 'Cancelled by admin' : 'Not paid', 'cancelled'];
    return ['Waiting for payment', 'cancelled'];
  }

  function readForm() {
    const v = {};
    for (const f of FIELDS) v[f] = $('f-' + f).value.trim();
    return v;
  }
  function writeForm(v) {
    for (const f of FIELDS) $('f-' + f).value = v[f];
  }
  function query(v, withPage) {
    const p = new URLSearchParams();
    for (const f of FIELDS) if (v[f] && v[f] !== DEFAULTS[f]) p.set(f, v[f]);
    if (withPage && page > 1) p.set('page', String(page));
    return p.toString();
  }

  function note(text, kind) {
    $('notice').replaceChildren(text ? h('div', { class: 'banner ' + (kind || 'info'), role: 'status' }, text) : '');
  }

  async function cancel(r) {
    const text = r.status === 'refund_failed' ? `Try the refund again for ${r.plate} (${rupees(r.amount)})?` : `Cancel the booking of ${r.plate} (bay ${r.bay}) and refund ${rupees(r.amount)} to the customer?`;
    if (!window.confirm(text)) return;
    try {
      const res = await post('/api/dashboard/bookings/' + encodeURIComponent(r.ref) + '/cancel', {});
      note(res.message, 'info');
    } catch (err) {
      note(err.message, 'bad');
    }
    load();
  }

  function table(rows) {
    if (!rows.length) return h('p', { class: 'muted' }, 'No bookings match these filters.');
    const heads = ['Reference', 'Paid', 'Customer', 'Vehicle', 'Bay', 'Parking time', 'Amount', 'Status', 'Razorpay payment'];
    if (canRefund) heads.push('Action');
    return h(
      'table',
      { class: 'table table-wide' },
      h('caption', { class: 'sr-only' }, 'Bookings'),
      h('thead', null, h('tr', null, heads.map((t) => h('th', { scope: 'col', class: t === 'Amount' ? 'num' : null }, t)))),
      h(
        'tbody',
        null,
        rows.map((r) => {
          const [label, cls] = statusOf(r);
          return h(
            'tr',
            null,
            h('td', { class: 'mono' }, r.ref),
            h('td', { class: 'nowrap' }, r.paidAt ? [S.formatDate(r.paidAt, off), h('span', { class: 'sub' }, S.formatTime(r.paidAt, off))] : [h('span', { class: 'fine' }, 'Not paid'), h('span', { class: 'sub' }, 'Started ' + S.formatDate(r.createdAt, off))]),
            h('td', null, r.customer ? [r.customer.name, h('span', { class: 'sub' }, r.customer.email)] : h('span', { class: 'fine' }, 'Guest')),
            h('td', null, h('span', { class: 'mono' }, r.plate), h('span', { class: 'sub' }, r.vehicleLabel)),
            h('td', null, r.bay, h('span', { class: 'sub' }, r.zone)),
            h('td', null, r.window),
            h('td', { class: 'num' }, rupees(r.amount)),
            h('td', null, h('span', { class: 'badge ' + cls }, label)),
            h('td', null, r.paymentId ? h('span', { class: 'mono wrap-id' }, shownId(r.paymentId)) : '–', r.orderId ? h('span', { class: 'sub wrap-id' }, 'Order ' + r.orderId) : null, r.refundId ? h('span', { class: 'sub wrap-id' }, 'Refund ' + r.refundId) : null),
            canRefund ? h('td', null, r.canCancel ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-label': `${r.status === 'refund_failed' ? 'Retry the refund for' : 'Cancel the booking for'} ${r.plate}`, onclick: () => cancel(r) }, r.status === 'refund_failed' ? 'Retry refund' : 'Cancel and refund') : null) : null
          );
        })
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
    await ready;
    const v = readForm();
    const qs = query(v, false);
    $('f-csv').href = '/api/dashboard/export.csv' + (qs ? '?' + qs : '');
    history.replaceState(null, '', location.pathname + (query(v, true) ? '?' + query(v, true) : ''));
    try {
      const d = await api('/api/dashboard/all-bookings?' + (qs ? qs + '&' : '') + 'page=' + page);
      if (mine !== seq) return;
      off = d.utcOffsetMinutes;
      page = d.page;
      $('updated').textContent = 'Updated ' + S.formatTime(d.serverTime, d.utcOffsetMinutes);
      $('totals').replaceChildren(
        h('span', null, 'Shown: ', h('b', null, String(d.totals.count))),
        h('span', null, 'Paid: ', h('b', null, `${d.totals.paidCount} for ${rupees(d.totals.paid)}`)),
        h('span', null, 'Refunded: ', h('b', null, `${d.totals.refundedCount} for ${rupees(d.totals.refunded)}`))
      );
      $('list').replaceChildren(table(d.rows));
      pager(d);
    } catch (err) {
      if (mine !== seq) return;
      $('updated').textContent = 'Could not load';
      note(err.status === 403 ? 'This page is only for the admin. ' + err.message : err.message, 'bad');
    }
  }

  // start from the address (so a link such as /bookings?q=ab12 works), then load
  const params = new URLSearchParams(location.search);
  const start = {};
  for (const f of FIELDS) start[f] = params.has(f) ? params.get(f) : DEFAULTS[f];
  writeForm(start);
  page = Math.max(1, parseInt(params.get('page'), 10) || 1);

  $('filters').addEventListener('submit', (e) => {
    e.preventDefault();
    page = 1;
    load();
  });
  $('f-reset').addEventListener('click', () => {
    writeForm(DEFAULTS);
    page = 1;
    load();
  });
  for (const f of ['status', 'vehicle', 'when', 'sort']) {
    $('f-' + f).addEventListener('change', () => {
      page = 1;
      load();
    });
  }
  load();
  B.poll(async () => {
    if (!document.activeElement || document.activeElement.tagName !== 'INPUT') await load();
  }, 60000);
})();
