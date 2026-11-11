/*
 * Operator dashboard. Every number comes from the server's real bookings; nothing here is made up.
 * The page is built once and then updated in place every few seconds, so it never flickers.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees } = B;
  const $ = (id) => document.getElementById(id);

  const CELL_TEXT = { f: 'free', u: 'in use now', b: 'booked for later today', h: 'payment in progress' };
  const STATUS_TEXT = { paid: 'Paid', refunded: 'Refunded', refund_pending: 'Refund sending', refund_failed: 'Refund failed', cancelled: 'Cancelled' };
  const statusText = (r) => (r.status === 'refunded' && r.cancelledByOperator ? 'Cancelled, refunded' : STATUS_TEXT[r.status] || r.status);
  // Shown instead of "Razorpay said: ..." when the refund was cut off by a restart (Razorpay never answered).
  const INTERRUPTED_TEXT = 'The server restarted while this refund was being sent, so nobody knows whether it went through. Retrying is safe: Razorpay does not refund the same payment in full twice, and if the first try did go through, this booking is just marked as refunded.';

  let cfg = null;
  let ui = null; // the page's elements, created on the first refresh
  // The lists are only redrawn when something in them changed, so a button is never swapped out from under a click.
  let attentionKey = null;
  let recentKey = null;

  const shownId = (id) => (id ? String(id).replace(/^demo_/, 'test_') : '–');
  const hourLabel = (hour) => (hour % 12 || 12) + (hour < 12 ? ' am' : ' pm');
  const bays = (n) => `${n} ${n === 1 ? 'bay' : 'bays'}`;

  // ---- Building the page (once) ---------------------------------------------------------------------------
  function makeTile(extraClass, label) {
    const n = h('p', { class: 'n' }, '–');
    const note = h('p', { class: 'note' });
    return { root: h('div', { class: 'tile ' + extraClass }, h('p', { class: 'k' }, label), n, note), n, note };
  }

  function makeCount(label) {
    const value = h('dd', null, '–');
    return { root: h('div', null, h('dt', null, label), value), value };
  }

  function makeLot(vehicle) {
    const lot = cfg.lot[vehicle];
    const inUse = h('span', null, '–');
    const meter = h('div');
    const free = makeCount('Free now');
    const later = makeCount('Booked later today');
    const held = makeCount('Payment in progress');
    const cells = Array.from({ length: lot.total }, (_, i) => h('div', { class: 'cell' }, String(i + 1)));
    const map = h('div', { class: 'map-grid' }, cells);
    const bars = Array.from({ length: 24 }, () => h('div', { class: 'hbar' }));
    const hours = h('div', { class: 'hours' }, bars);
    const busiest = h('p', { class: 'fine' });
    const areaName = vehicle === 'car' ? 'levels' : 'zones';
    const root = h(
      'section',
      { class: 'panel', 'aria-labelledby': 'lot-' + vehicle },
      h('div', { class: 'panel-head' }, h('h2', { id: 'lot-' + vehicle }, lot.label + ' bays'), h('p', { class: 'fine' }, `${lot.total} bays in ${lot.zones.length} ${areaName}`)),
      h('div', { class: 'stack g8' }, h('div', { class: 'meter-row' }, h('b', null, 'In use now'), inUse), h('div', { class: 'meter-light' }, meter)),
      h('dl', { class: 'counts' }, free.root, later.root, held.root),
      h('div', { class: 'stack g12' }, h('h3', { class: 'sub-h' }, 'Bay map'), map),
      h(
        'div',
        { class: 'legend' },
        h('span', null, h('i', { class: 'swatch sw-free' }), 'Free'),
        h('span', null, h('i', { class: 'swatch sw-used' }), 'In use now'),
        h('span', null, h('i', { class: 'swatch sw-later' }), 'Booked later today'),
        h('span', null, h('i', { class: 'swatch sw-held' }), 'Payment in progress')
      ),
      h(
        'div',
        { class: 'stack g8' },
        h('h3', { class: 'sub-h' }, 'Bays booked in each hour today'),
        hours,
        h('div', { class: 'hours-axis', 'aria-hidden': 'true' }, ['12 am', '6 am', '12 pm', '6 pm', '11 pm'].map((t) => h('span', null, t))),
        busiest
      )
    );
    return { root, inUse, meter, free: free.value, later: later.value, held: held.value, cells, bars, busiest };
  }

  function build() {
    ui = {
      tiles: { car: makeTile('tile-dark', ''), bike: makeTile('', ''), payments: makeTile('', 'Payments today'), money: makeTile('', 'Received today') },
      lots: { car: makeLot('car'), bike: makeLot('bike') },
    };
    ui.tiles.car.root.firstChild.textContent = cfg.lot.car.label + ' bays in use now';
    ui.tiles.bike.root.firstChild.textContent = cfg.lot.bike.label + ' bays in use now';
    $('tiles').replaceChildren(ui.tiles.car.root, ui.tiles.bike.root, ui.tiles.payments.root, ui.tiles.money.root);
    $('lots').replaceChildren(ui.lots.car.root, ui.lots.bike.root);
  }

  // ---- Updating it ---------------------------------------------------------------------------------------------
  function updateLot(vehicle, data, d) {
    const u = ui.lots[vehicle];
    u.inUse.textContent = `${data.inUse} of ${data.total}`;
    u.meter.style.width = (data.total ? (data.inUse / data.total) * 100 : 0) + '%';
    u.free.textContent = String(data.free);
    u.later.textContent = String(data.laterToday);
    u.held.textContent = String(data.held);

    for (let i = 0; i < data.total; i++) {
      const code = data.bays[i];
      const cell = u.cells[i];
      const cls = 'cell' + (code === 'u' ? ' u' : code === 'b' ? ' b' : code === 'h' ? ' h' : '');
      if (cell.className !== cls) cell.className = cls;
      const title = `${S.bayId(vehicle, i + 1)}: ${CELL_TEXT[code]}`;
      if (cell.title !== title) cell.title = title;
    }

    const peak = Math.max(...data.hourly, 0);
    const nowHour = S.lotParts(d.serverTime, d.utcOffsetMinutes).h;
    data.hourly.forEach((n, hour) => {
      const bar = u.bars[hour];
      bar.style.height = n ? Math.max(4, Math.round((n / Math.max(peak, 1)) * 100)) + '%' : '2px';
      bar.className = 'hbar' + (hour === nowHour ? ' now' : '');
      bar.title = `${hourLabel(hour)}: ${bays(n)} booked`;
    });
    const busiestHour = data.hourly.indexOf(peak);
    u.busiest.textContent = peak ? `Busiest hour: ${hourLabel(busiestHour)}, with ${bays(peak)} booked. The dark bar is the hour it is now.` : 'No bookings today yet.';
  }

  function updateTiles(d) {
    const { car, bike } = d.lot;
    ui.tiles.car.n.textContent = String(car.inUse);
    ui.tiles.car.note.textContent = `of ${car.total} bays, ${car.laterToday} more booked for later today`;
    ui.tiles.bike.n.textContent = String(bike.inUse);
    ui.tiles.bike.note.textContent = `of ${bike.total} bays, ${bike.laterToday} more booked for later today`;
    ui.tiles.payments.n.textContent = String(d.paymentsToday);
    ui.tiles.payments.note.textContent = `${car.paymentsToday} for cars, ${bike.paymentsToday} for two-wheelers`;
    ui.tiles.money.n.textContent = rupees(d.revenueToday);
    ui.tiles.money.note.textContent = `${rupees(car.revenueToday)} from cars, ${rupees(bike.revenueToday)} from two-wheelers`;
  }

  function noticeNodes(d) {
    const list = [];
    if (!d.operatorProtected) {
      list.push(h('div', { class: 'banner warn' }, h('b', null, 'This page has no password. '), 'Anyone who can open this address can see it. Set OPERATOR_PASSWORD in the server settings before you put the site online.'));
    }
    if (d.paymentMode === 'demo') {
      list.push(h('div', { class: 'banner info' }, h('b', null, 'Simulated payments. '), 'This computer has no Razorpay keys, so payments are only pretended. A live website never does this: without keys it switches booking off.'));
    }
    // What is wrong with, or worth knowing about, the Razorpay connection (the same list the Business page shows)
    for (const p of (d.payments && d.payments.problems) || []) {
      list.push(h('div', { class: 'banner ' + (p.level === 'bad' ? 'bad' : p.level === 'warn' ? 'warn' : 'info') }, p.text));
    }
    return list;
  }

  function attentionNodes(d) {
    if (!d.attention.length) return [h('p', { class: 'msg ok' }, 'Nothing needs your attention right now.')];
    return d.attention.map((r) =>
      r.status === 'refund_failed'
        ? h(
            'div',
            { class: 'banner bad' },
            h('b', null, 'Refund needed. '),
            `${r.plate}, bay ${r.bay}, ${rupees(r.amount)}. Razorpay payment ${shownId(r.paymentId)}. `,
            r.refundInterrupted
              ? INTERRUPTED_TEXT
              : `${r.refundError ? `Razorpay said: ${r.refundError}. ` : ''}Try the refund again, or send it from the Razorpay dashboard.`,
            h('div', { class: 'banner-actions' }, h('button', { class: 'btn btn-navy btn-sm', type: 'button', onclick: () => openInPanel(r.plate) }, 'Retry refund'))
          )
        : h('div', { class: 'banner warn' }, h('b', null, 'A refund is being sent. '), `${r.plate}, ${rupees(r.amount)}. If this is still here after a few minutes, check the Razorpay dashboard.`)
    );
  }

  function recentTable(d) {
    if (!d.recent.length) return h('p', { class: 'muted' }, 'No payments yet.');
    const off = d.utcOffsetMinutes;
    const heads = ['Paid', 'Vehicle', 'Bay', 'Booked for', 'Amount', 'Status', 'Razorpay payment', 'Action'];
    return h(
      'table',
      { class: 'table' },
      h('caption', { class: 'sr-only' }, 'Recent payments and refunds'),
      h('thead', null, h('tr', null, heads.map((t, i) => h('th', { scope: 'col', class: i === 4 ? 'num' : null }, t)))),
      h(
        'tbody',
        null,
        d.recent.map((r) =>
          h(
            'tr',
            null,
            h('td', null, r.paidAt ? `${S.formatDate(r.paidAt, off)}, ${S.formatTime(r.paidAt, off)}` : '–'),
            h('td', null, h('span', { class: 'mono' }, r.plate), h('br'), h('span', { class: 'fine' }, r.vehicleLabel)),
            h('td', null, r.bay),
            h('td', null, r.window),
            h('td', { class: 'num' }, rupees(r.amount)),
            h('td', null, h('span', { class: 'badge ' + r.status }, statusText(r))),
            h('td', { class: 'mono' }, shownId(r.paymentId)),
            h(
              'td',
              null,
              r.canCancel
                ? h(
                    'button',
                    {
                      class: 'btn btn-outline btn-sm',
                      type: 'button',
                      'aria-label': `${r.status === 'refund_failed' ? 'Retry the refund for' : 'Cancel the booking for'} ${r.plate}`,
                      onclick: () => openInPanel(r.plate),
                    },
                    r.status === 'refund_failed' ? 'Retry refund' : 'Cancel…'
                  )
                : null
            )
          )
        )
      )
    );
  }

  // ---- Cancel and refund a booking ---------------------------------------------------------------------------
  // Type a vehicle number, see its bookings that can still be cancelled, press the button, confirm. The server
  // does the real work: it frees the bay and asks Razorpay to send the whole amount back.
  const cancelForm = $('cancel-form');
  const cancelInput = $('cancel-plate');
  const cancelGo = $('cancel-go');
  const cancelOut = $('cancel-results');
  const cancelPlate = B.plateField(cancelInput, $('cancel-plate-help'));
  let cancelSeq = 0;

  const failText = (err) => (err.status === 401 ? 'Sign in needed. Reload this page and enter the operator user name and password.' : err.message);
  const fact = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
  const button = (label, cls, onclick) => h('button', { class: cls, type: 'button', onclick }, label);

  function pillFor(b) {
    if (b.status === 'refund_failed') return h('span', { class: 'state-pill refund_failed' }, 'Refund failed');
    if (b.status === 'refund_pending') return h('span', { class: 'state-pill refund_pending' }, 'Refund being sent');
    return h('span', { class: 'state-pill ' + b.state }, b.state === 'active' ? 'On now' : b.state === 'upcoming' ? 'Upcoming' : 'Ended');
  }

  function bookingCard(b) {
    const retry = b.status === 'refund_failed';
    const amount = rupees(b.amount);
    const actions = h('div', { class: 'cancel-actions' });
    const card = h(
      'article',
      { class: 'cancel-card' + (b.state === 'active' && !retry ? ' on' : '') },
      h(
        'div',
        { class: 'cancel-top' },
        h('div', { class: 'stack g8' }, h('h3', { class: 'cancel-plate' }, b.plate), h('p', { class: 'fine' }, `${b.vehicleLabel}, bay ${b.bay} (${b.zone})`)),
        pillFor(b)
      ),
      h('dl', { class: 'cancel-facts' }, fact('Booked for', b.window), fact('Amount paid', amount), fact('Booking reference', b.ref), fact('Razorpay payment', shownId(b.paymentId))),
      b.refundInterrupted ? h('p', { class: 'msg err' }, INTERRUPTED_TEXT) : b.refundError ? h('p', { class: 'msg err' }, `Razorpay said: ${b.refundError}`) : null,
      actions
    );

    function showStart() {
      if (b.status === 'refund_pending') {
        actions.replaceChildren(h('p', { class: 'fine' }, 'A refund for this booking is being sent. Search again in a moment.'));
      } else if (retry) {
        actions.replaceChildren(button('Retry refund of ' + amount, 'btn btn-navy btn-sm', run));
      } else {
        actions.replaceChildren(button('Cancel and refund ' + amount, 'btn btn-danger-outline btn-sm', showConfirm));
      }
    }

    function showConfirm() {
      const keep = button('Keep booking', 'btn btn-outline btn-sm', showStart);
      actions.replaceChildren(
        h(
          'p',
          { class: 'cancel-ask' },
          b.state === 'active' ? 'This booking is on right now. ' : '',
          `Cancel booking ${b.ref} for ${b.plate}? Bay ${b.bay} is freed straight away and ${amount} goes back to the customer's original payment method. This cannot be undone.`
        ),
        button(`Yes, cancel and refund ${amount}`, 'btn btn-danger btn-sm', run),
        keep
      );
      keep.focus(); // the safe choice is the one under the keyboard
    }

    async function run() {
      actions.replaceChildren(h('div', { class: 'working muted', role: 'status' }, h('span', { class: 'spinner' }), retry ? 'Sending the refund…' : 'Cancelling and sending the refund…'));
      const again = S.normalizePlate(b.plate);
      let note;
      try {
        const res = await B.post('/api/dashboard/bookings/' + encodeURIComponent(b.ref) + '/cancel', {});
        note = h('p', { class: 'msg ok', role: 'status' }, res.message);
      } catch (err) {
        note = h('p', { class: 'msg err', role: 'alert' }, failText(err));
      }
      refresh();
      search(again, { note, quiet: true });
    }

    showStart();
    return card;
  }

  function emptyCard(plateText) {
    return h(
      'div',
      { class: 'empty-card' },
      h('h3', { class: 'sub-h' }, 'Nothing to cancel for ' + plateText),
      h('p', { class: 'muted' }, 'This vehicle number has no paid booking that is still to come or on now, and no refund waiting to be retried. Check the number: a different number is a different booking.')
    );
  }

  async function search(norm, { note = null, quiet = false, focusFirst = false } = {}) {
    const mine = ++cancelSeq;
    cancelGo.disabled = true;
    if (!quiet) cancelOut.replaceChildren(h('div', { class: 'working muted', role: 'status' }, h('span', { class: 'spinner' }), 'Looking…'));
    try {
      const data = await B.api('/api/dashboard/bookings?plate=' + encodeURIComponent(norm));
      if (mine !== cancelSeq) return;
      const cards = data.bookings.map(bookingCard);
      cancelOut.replaceChildren(...[note, ...(cards.length || note ? cards : [emptyCard(data.plate)])].filter(Boolean));
      if (focusFirst) {
        const first = cancelOut.querySelector('button');
        if (first) first.focus();
      }
    } catch (err) {
      if (mine !== cancelSeq) return;
      cancelOut.replaceChildren(...[note, h('p', { class: 'msg err', role: 'alert' }, failText(err))].filter(Boolean));
    } finally {
      if (mine === cancelSeq) cancelGo.disabled = false;
    }
  }

  // The "Cancel…" and "Retry refund" buttons in the lists below take you here with the vehicle number filled in.
  function openInPanel(plateText) {
    cancelPlate.set(plateText);
    const norm = cancelPlate.value();
    if (!norm) return;
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('cancel-panel').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    search(norm, { focusFirst: true });
  }

  cancelForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const norm = cancelPlate.validate();
    if (!norm) {
      cancelOut.replaceChildren();
      cancelInput.focus();
      return;
    }
    search(norm);
  });

  // ---- Setup check ---------------------------------------------------------------------------------------------
  // For whoever put the website online. The server says how it sees this very request; this turns that into sentences.
  const checkGo = $('check-go');
  const checkOut = $('check-results');

  const sinceText = (seconds) => {
    if (seconds < 90) return 'less than 2 minutes';
    const minutes = Math.round(seconds / 60);
    if (minutes < 120) return `${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
  };

  function addressBlock(r) {
    const inUse = r.trustProxy === null ? 0 : r.trustProxy;
    const intro = h(
      'div',
      { class: 'stack g8' },
      h('h3', { class: 'sub-h' }, 'Telling visitors apart'),
      h('p', null, 'The site sees your address as ', h('b', { class: 'mono' }, r.address), '. The setting TRUST_PROXY is ', h('b', null, r.trustProxy === null ? 'not set' : String(r.trustProxy)), '.')
    );
    if (r.options.length < 2) {
      return h(
        'div',
        { class: 'stack g12' },
        intro,
        h('p', { class: 'muted' }, 'This request came without an X-Forwarded-For header, so no proxy is in front of the site, or it is not passing visitors’ addresses on. On your own computer that is normal. On a hosting service, ask the host.')
      );
    }
    const rows = r.options.map((o) =>
      h(
        'tr',
        { class: o.trust === inUse ? 'now' : null },
        h('th', { scope: 'row' }, String(o.trust)),
        h('td', { class: 'mono' }, o.address, o.trust === inUse ? [' ', h('span', { class: 'badge paid' }, 'in use now')] : null)
      )
    );
    return h(
      'div',
      { class: 'stack g12' },
      intro,
      h('p', { class: 'muted' }, 'With each setting, the site would see this address for you:'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'check-table' },
          h('caption', { class: 'sr-only' }, 'The address the site would see for each TRUST_PROXY setting'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'TRUST_PROXY'), h('th', { scope: 'col' }, 'Address seen'))),
          h('tbody', null, rows)
        )
      ),
      h(
        'p',
        { class: 'muted' },
        'Open a website that shows your own public address (search the web for “what is my IP address”). The right setting is the ',
        h('b', null, 'lowest number'),
        ' whose row shows exactly that address. If it is not the one marked “in use now”, change TRUST_PROXY in the server settings and run the check again.'
      )
    );
  }

  function secureBlock(r) {
    return h(
      'div',
      { class: 'stack g8' },
      h('h3', { class: 'sub-h' }, 'Secure connection'),
      r.secure
        ? h('p', { class: 'msg ok' }, 'Yes. The site knows this page was opened over HTTPS.')
        : h('p', { class: 'msg info' }, 'The site does not see this connection as HTTPS. On your own computer that is normal. If you opened this page with https:// on the internet, the site is not being told, so TRUST_PROXY needs a number above 0 (see above).')
    );
  }

  function storageBlock(r) {
    const s = r.storage;
    if (s.kind === 'database') {
      return h(
        'div',
        { class: 'stack g12' },
        h('h3', { class: 'sub-h' }, 'Where bookings are saved'),
        h(
          'dl',
          { class: 'check-facts' },
          fact('Saved in', h('span', { class: 'mono' }, `the database at ${s.database}`)),
          fact('Bookings in it', String(s.bookings)),
          fact('Site running for', sinceText(r.uptimeSeconds)),
          fact('Node.js', r.node)
        ),
        s.databaseError
          ? h('p', { class: 'msg err', role: 'alert' }, h('b', null, 'The database is not accepting changes right now. '), `${s.databaseError}. New bookings are paused and every change is tried again automatically. Check that the database is running and that DATABASE_URL in Render is right.`)
          : h('p', { class: 'msg ok' }, 'Yes. Bookings and customer accounts are kept in the database, so they stay when the site sleeps, restarts or is updated.')
      );
    }
    const warn =
      s.onRender && s.onDisk === false
        ? h('p', { class: 'msg err', role: 'alert' }, h('b', null, 'Bookings are not on the Render disk. '), `They are lost every time the site restarts or is updated. Remove the DATA_DIR setting in Render, or point it at a folder inside ${s.diskPath}. Exception: the free test site (render-free.yaml) has no disk, so there this is expected: leave DATA_DIR as it is, and use Razorpay test keys only (live keys switch booking off there, so no real money is taken for bookings that could be lost).`)
        : s.onRender
          ? h('p', { class: 'msg ok' }, `Yes. This folder is on the Render disk (${s.diskPath}), so bookings stay when the site restarts or is updated.`)
          : null;
    return h(
      'div',
      { class: 'stack g12' },
      h('h3', { class: 'sub-h' }, 'Where bookings are saved'),
      h(
        'dl',
        { class: 'check-facts' },
        fact('Folder', h('span', { class: 'mono' }, s.folder)),
        fact('Bookings in it', String(s.bookings)),
        fact('Site running for', sinceText(r.uptimeSeconds)),
        fact('Node.js', r.node)
      ),
      warn
    );
  }

  // How the chat window answers visitors, in sentences. The server sends counts and one message, never a key and never
  // anything a visitor typed.
  function chatBlock(r) {
    const c = r.chat;
    if (!c) return null;
    const notes = [];
    if (c.mode === 'off') {
      notes.push(h('p', { class: 'msg info' }, 'The chat is switched off (CHAT_ENABLED), so visitors see no chat button.'));
    } else if (c.mode === 'instant') {
      notes.push(
        h(
          'p',
          { class: 'msg info' },
          'The chat answers from the website’s own settings: prices, free bays, how to book. To let an AI write the answers as well, add ANTHROPIC_API_KEY in the server settings (the README says how), then run this check again.'
        )
      );
    } else if (c.problem) {
      const ago = sinceText(Math.max(0, Math.round((B.now() - c.problem.at) / 1000)));
      notes.push(h('p', { class: 'msg err', role: 'alert' }, h('b', null, 'The AI is not answering. '), `${c.problem.text} That was ${ago} ago. Visitors get the built-in answers meanwhile.`));
    } else {
      notes.push(
        h('p', { class: 'msg ok' }, c.aiToday ? 'The AI is answering visitors.' : 'The AI is switched on. Nothing has been asked yet today, so this check cannot tell yet whether the key works. Ask the chat a question on the site, then run the check again.')
      );
    }
    if (c.keyLooksWrong) {
      notes.push(h('p', { class: 'msg err', role: 'alert' }, 'ANTHROPIC_API_KEY does not look like an Anthropic key (they start with sk-ant-). Check that it was copied in full.'));
    }
    const facts = [fact('How it answers', c.mode === 'off' ? 'Switched off' : c.mode === 'ai' ? 'AI, then built-in answers' : 'Built-in answers only')];
    if (c.mode === 'ai') {
      facts.push(fact('AI model', h('span', { class: 'mono' }, c.model)), fact('Sent to the AI today', `${c.aiToday} of ${c.dailyLimit} allowed`));
    }
    if (c.mode !== 'off') facts.push(fact('Built-in answers today', String(c.instantToday)));
    return h('div', { class: 'stack g12' }, h('h3', { class: 'sub-h' }, 'Chat assistant'), h('dl', { class: 'check-facts' }, facts), notes);
  }

  async function runCheck() {
    checkGo.disabled = true;
    checkOut.replaceChildren(h('div', { class: 'working muted', role: 'status' }, h('span', { class: 'spinner' }), 'Checking…'));
    try {
      const r = await B.api('/api/dashboard/connection');
      checkOut.replaceChildren(...[addressBlock(r), secureBlock(r), storageBlock(r), chatBlock(r)].filter(Boolean));
    } catch (err) {
      checkOut.replaceChildren(h('p', { class: 'msg err', role: 'alert' }, failText(err)));
    } finally {
      checkGo.disabled = false;
      checkGo.textContent = 'Run the check again';
    }
  }
  checkGo.addEventListener('click', runCheck);

  async function refresh() {
    let d;
    try {
      cfg = cfg || (await B.getConfig());
      d = await B.api('/api/dashboard');
    } catch (err) {
      $('updated').textContent = err.status === 401 ? 'Sign in needed. Reload this page and enter the operator user name and password.' : 'Could not refresh: ' + err.message;
      return;
    }
    if (!ui) build();
    updateTiles(d);
    updateLot('car', d.lot.car, d);
    updateLot('bike', d.lot.bike, d);
    $('notice').replaceChildren(...noticeNodes(d));
    const nextAttention = JSON.stringify(d.attention);
    if (nextAttention !== attentionKey) {
      attentionKey = nextAttention;
      $('attention').replaceChildren(...attentionNodes(d));
    }
    const nextRecent = JSON.stringify([d.recent, d.utcOffsetMinutes]);
    if (nextRecent !== recentKey) {
      recentKey = nextRecent;
      $('recent').replaceChildren(recentTable(d));
    }
    $('updated').textContent = `Updated ${S.formatTime(d.serverTime, d.utcOffsetMinutes)}. Refreshes every 15 seconds.`;
  }

  B.poll(refresh, 15 * 1000);
})();
