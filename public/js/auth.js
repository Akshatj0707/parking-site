/*
 * The sign in, sign up and "My bookings" pages. One script for the three pages: /login, /signup and /account.
 * Anything that comes from the server is put on the page as text, never as HTML.
 */
(function () {
  'use strict';

  const { h, post, api, getConfig, session, refreshSession, rupees, signOut } = window.Bayfind;
  const root = document.getElementById('auth-root');
  const view = location.pathname.replace(/\/+$/, '') || '/';

  // Only a path on this site is accepted as the place to go afterwards.
  function safeNext() {
    const next = new URLSearchParams(location.search).get('next');
    return next && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/.test(next) ? next : null;
  }
  const operatorPath = (path) => /^\/(dashboard|analytics|business|bookings|customers|officials|scan)(\/|\?|$)/.test(path);
  const isStaff = (user) => user.role === 'admin' || user.role === 'official';

  function field(id, label, attrs, help) {
    const input = h('input', Object.assign({ class: 'input', id, name: id, required: true }, attrs));
    return { input, node: h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, help ? h('p', { class: 'help' }, help) : null) };
  }

  function formShell({ eyebrow, title, lead }) {
    return [
      h('div', { class: 'stack g12 rise' }, h('p', { class: 'eyebrow' }, eyebrow), h('h1', { class: 'h1' }, title), lead ? h('p', { class: 'lead' }, lead) : null),
    ];
  }

  function show(box, text, kind) {
    box.textContent = '';
    if (text) box.append(h('p', { class: 'msg ' + (kind || 'err'), role: kind === 'ok' ? 'status' : 'alert' }, text));
  }

  // ---- Sign in ---------------------------------------------------------------------------------------------
  async function loginView(cfg, user) {
    document.title = 'Sign in · ' + cfg.siteName;
    if (user) return alreadyIn(user);
    const id = field('identifier', 'Email, or the owner user name', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: '120' });
    const pw = field('password', 'Password', { type: 'password', autocomplete: 'current-password', maxlength: '100' });
    const message = h('div', { 'aria-live': 'polite' });
    const go = h('button', { class: 'btn btn-navy btn-tall', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'panel rise d2', novalidate: true }, id.node, pw.node, message, go);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!id.input.value.trim() || !pw.input.value) return show(message, 'Enter your email and password.');
      go.disabled = true;
      show(message, '');
      try {
        const done = await post('/api/auth/login', { identifier: id.input.value, password: pw.input.value });
        await refreshSession();
        const wanted = safeNext();
        // staff (the owner, a government official) may go to a staff page; a customer never is sent to one
        location.assign(wanted && (isStaff(done.user) || !operatorPath(wanted)) ? wanted : done.next);
      } catch (err) {
        go.disabled = false;
        show(message, err.message);
      }
    });
    const kids = formShell({ eyebrow: 'Sign in', title: 'Welcome back', lead: 'Customers and government officials sign in with their email. The parking owner signs in with the owner user name.' });
    kids.push(form);
    const test = cfg.auth && cfg.auth.testCustomer;
    if (test) {
      kids.push(
        h('div', { class: 'msg info' }, h('b', null, 'Want to look around? '), `Use the test customer: ${test.email} with the password ${test.password}. `,
          h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { id.input.value = test.email; pw.input.value = test.password; pw.input.focus(); } }, 'Fill it in'))
      );
    }
    kids.push(h('p', { class: 'fine' }, 'New here? ', h('a', { href: '/signup' + location.search }, 'Create an account'), '.'));
    root.replaceChildren(...kids);
  }

  // ---- Sign up ---------------------------------------------------------------------------------------------
  async function signupView(cfg, user) {
    document.title = 'Create account · ' + cfg.siteName;
    if (user) return alreadyIn(user);
    const name = field('name', 'Your name', { type: 'text', autocomplete: 'name', maxlength: '60' });
    const email = field('email', 'Email', { type: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', maxlength: '120' });
    const pw = field('password', 'Password', { type: 'password', autocomplete: 'new-password', minlength: '8', maxlength: '100' }, 'At least 8 characters.');
    const message = h('div', { 'aria-live': 'polite' });
    const go = h('button', { class: 'btn btn-navy btn-tall', type: 'submit' }, 'Create account');
    const kids = formShell({ eyebrow: 'Create account', title: 'Book a bay in a minute', lead: 'With an account you can book a bay and see all your bookings in one place.' });
    const form = h('form', { class: 'panel rise d2', novalidate: true }, name.node, email.node, pw.node, message, go);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!name.input.value.trim() || !email.input.value.trim() || pw.input.value.length < 8) {
        return show(message, 'Enter your name, your email and a password of at least 8 characters.');
      }
      go.disabled = true;
      show(message, '');
      try {
        await post('/api/auth/signup', { name: name.input.value, email: email.input.value, password: pw.input.value });
        await refreshSession();
        const wanted = safeNext();
        location.assign(wanted && !operatorPath(wanted) ? wanted : '/account');
      } catch (err) {
        go.disabled = false;
        show(message, err.message);
      }
    });
    kids.push(form);
    if (cfg.auth && cfg.auth.persistent === false) {
      kids.push(h('p', { class: 'msg info' }, 'This is a test site. Accounts and bookings are cleared whenever the site restarts.'));
    }
    kids.push(h('p', { class: 'fine' }, 'Already have an account? ', h('a', { href: '/login' + location.search }, 'Sign in'), '.'));
    root.replaceChildren(...kids);
  }

  function alreadyIn(user) {
    const staff = isStaff(user);
    root.replaceChildren(
      ...formShell({
        eyebrow: 'Signed in',
        title: 'You are signed in',
        lead: user.role === 'admin' ? (user.email ? `Signed in as an admin (${user.name}).` : `Signed in as the parking owner (${user.name}).`) : user.role === 'official' ? `Signed in as a government official (${user.name}).` : `Signed in as ${user.name}.`,
      }),
      h('div', { class: 'row' },
        staff ? h('a', { class: 'btn btn-navy', href: '/dashboard' }, 'Open the dashboard') : h('a', { class: 'btn btn-navy', href: '/account' }, 'My bookings'),
        staff ? h('a', { class: 'btn btn-outline', href: '/business' }, 'Business overview') : h('a', { class: 'btn btn-outline', href: '/book' }, 'Book a bay'),
        staff ? h('button', { class: 'btn btn-outline', type: 'button', onclick: signOut }, 'Sign out') : null)
    );
  }

  // ---- My bookings -----------------------------------------------------------------------------------------
  const STATE_TEXT = { upcoming: 'Upcoming', active: 'Booked now', completed: 'Finished', cancelled: 'Cancelled', refunded: 'Cancelled and refunded' };
  // Where the vehicle is in its visit (the entry and exit QR codes), shown instead of the plain state once it has come in.
  const STAGE_TEXT = { inside: 'Parked', overstaying: 'Parked, over time', payment_due: 'Extra time to pay', left: 'Finished' };
  const STATE_CLASS = { upcoming: 'paid', active: 'paid', completed: 'cancelled', cancelled: 'cancelled', refunded: 'refunded' };

  // What the cancelled booking says about the money.
  function cancelledLine(b) {
    const who = b.cancelledBy === 'customer' ? 'You cancelled this booking.' : b.cancelledBy === 'operator' ? 'The parking owner cancelled this booking.' : '';
    if (b.state === 'refunded' || b.refundPending) {
      const part = b.refundAmount !== null && b.refundAmount !== undefined && b.refundAmount < b.amount ? ` ${rupees(b.refundAmount)} of ${rupees(b.amount)} was refunded.` : b.refundAmount ? ` ${rupees(b.refundAmount)} was refunded.` : ' The refund is on its way.';
      return `${who}${part} It usually reaches you in 5 to 10 working days.`.trim();
    }
    return who;
  }

  // Cancelling asks first: the panel says what comes back, and only the second press cancels. The amount shown is sent along, so a
  // refund that has changed in the meantime is never taken as agreed.
  function cancelControl(b, reload) {
    const box = h('div', { class: 'cancel-box' });
    const q = b.cancel;
    const show = (kids) => box.replaceChildren(...kids);
    function ask() {
      const full = q.refundPercent === 100;
      const text = q.refundAmount > 0
        ? `If you cancel now you get ${rupees(q.refundAmount)} back${full ? ' (everything you paid)' : ` (${q.refundPercent}% of ${rupees(b.amount)})`}.`
        : 'If you cancel now nothing is refunded.';
      const later = !full || q.rule.latePercent >= 100 ? '' : q.viaGrace && q.graceUntil ? ` This full refund is only for a few minutes after paying: after ${q.graceUntil} only ${q.rule.latePercent}% comes back.` : ` After ${q.freeUntil} only ${q.rule.latePercent}% comes back.`;
      const yes = h('button', { class: 'btn btn-danger', type: 'button', onclick: confirmCancel }, 'Yes, cancel this booking');
      const no = h('button', { class: 'btn btn-outline', type: 'button', onclick: idle }, 'Keep my booking');
      show([h('div', { class: 'msg info', role: 'status' }, h('b', null, 'Cancel booking ' + b.ref + '? '), text + later), h('div', { class: 'row' }, yes, no)]);
    }
    async function confirmCancel(event) {
      event.target.disabled = true;
      try {
        const r = await post('/api/account/bookings/' + encodeURIComponent(b.ref) + '/cancel', { acceptRefund: q.refundAmount });
        box.replaceChildren(h('p', { class: 'msg ok', role: 'status' }, r.message));
        setTimeout(reload, 2500);
      } catch (err) {
        show([h('p', { class: 'msg err', role: 'alert' }, err.message), h('div', { class: 'row' }, h('button', { class: 'btn btn-outline', type: 'button', onclick: reload }, 'Refresh my bookings'))]);
      }
    }
    function idle() {
      show([h('button', { class: 'btn btn-danger-outline', type: 'button', onclick: ask }, 'Cancel this booking')]);
    }
    idle();
    return box;
  }

  function bookingCard(b, reload) {
    const open = b.pass && b.stage !== 'left' && b.stage !== 'unused' && b.stage !== 'void';
    const cancelled = b.state === 'cancelled' || b.state === 'refunded';
    return h('li', { class: 'my-booking' },
      h('div', { class: 'my-booking-head' }, h('b', null, b.plate), h('span', { class: 'badge ' + (STATE_CLASS[b.state] || 'cancelled') }, STAGE_TEXT[b.stage] || STATE_TEXT[b.state] || b.state)),
      h('p', null, b.window),
      h('p', { class: 'muted' }, `${b.vehicleLabel}, bay ${b.bay} (${b.zone}) · ${b.hours} h · ${rupees(b.amount)}${b.extraTimeAmount ? ' (' + rupees(b.extraTimeAmount) + ' more for extra time)' : ''}`),
      h('p', { class: 'fine' }, 'Booking reference ', h('b', null, b.ref)),
      cancelled && cancelledLine(b) ? h('p', { class: 'fine' }, cancelledLine(b)) : null,
      open ? h('a', { class: 'btn btn-navy', href: b.pass }, b.stage === 'inside' ? 'Open QR codes or add more time' : 'Open entry and exit QR codes') : null,
      b.cancel ? cancelControl(b, reload) : null);
  }

  async function accountView(cfg, user) {
    document.title = 'My bookings · ' + cfg.siteName;
    if (!user) return location.replace('/login?next=' + encodeURIComponent('/account'));
    if (isStaff(user)) return alreadyIn(user);
    const list = h('ul', { class: 'my-bookings plain-list' }, h('li', { class: 'muted' }, 'Loading your bookings…'));
    const logout = h('button', { class: 'btn btn-outline', type: 'button', onclick: signOut }, 'Sign out');
    root.replaceChildren(
      ...formShell({ eyebrow: 'My account', title: `Hello, ${user.name}`, lead: user.email }),
      h('div', { class: 'row' }, h('a', { class: 'btn btn-navy', href: '/book' }, 'Book a bay'), logout),
      h('section', { class: 'panel', 'aria-labelledby': 'mine-title' }, h('h2', { id: 'mine-title' }, 'My bookings'), list),
      ...(cfg.auth && cfg.auth.persistent === false ? [h('p', { class: 'msg info' }, 'This is a test site. Accounts and bookings are cleared whenever the site restarts.')] : [])
    );
    async function load() {
      try {
        const data = await api('/api/account/bookings');
        list.replaceChildren(...(data.bookings.length ? data.bookings.map((b) => bookingCard(b, load)) : [h('li', { class: 'muted' }, 'You have no bookings yet. ', h('a', { href: '/book' }, 'Book a bay'), '.')]));
      } catch (err) {
        if (err.status === 401) return location.replace('/login?next=' + encodeURIComponent('/account'));
        list.replaceChildren(h('li', null, h('p', { class: 'msg err', role: 'alert' }, err.message)));
      }
    }
    await load();
  }

  async function init() {
    try {
      const [cfg, user] = await Promise.all([getConfig(), session()]);
      if (view === '/signup') await signupView(cfg, user);
      else if (view === '/account') await accountView(cfg, user);
      else await loginView(cfg, user);
    } catch (err) {
      root.replaceChildren(h('p', { class: 'msg err', role: 'alert' }, err.message || 'Something went wrong. Please reload the page.'));
    }
  }
  init();
})();
