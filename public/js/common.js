/*
 * Small helpers that every page uses. No libraries.
 * Anything that comes from the server is put on the page as text, never as HTML.
 */
(function () {
  'use strict';

  const S = window.BayfindShared;

  // ---- Talking to the server -------------------------------------------------------------------
  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status; // 0 means the server could not be reached at all
      this.code = code;
    }
  }

  async function api(path, options) {
    let res;
    try {
      // Asking for JSON tells the server this is the page's own request, not a person opening an address.
      res = await fetch(path, { ...options, headers: { Accept: 'application/json', ...((options && options.headers) || {}) } });
    } catch (err) {
      throw new ApiError(0, 'network', 'We could not reach the server. Check your internet connection and try again.');
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      // Some errors (such as the dashboard password prompt) are plain text.
    }
    if (res.status === 401 && data && data.error === 'login_required' && path.startsWith('/api/dashboard') && !/^\/(login|signup)\b/.test(location.pathname)) {
      // the operator pages need the operator to be signed in: go to the sign-in page and come back here afterwards
      location.assign('/login?next=' + encodeURIComponent(location.pathname));
      return new Promise(() => {});
    }
    if (!res.ok) {
      const plain = text && text.length < 200 && !/^\s*</.test(text) ? text : '';
      throw new ApiError(res.status, (data && data.error) || 'error', (data && data.message) || plain || 'Something went wrong. Please try again.');
    }
    return data;
  }

  const post = (path, body) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });

  // The settings (rates, lot size, payment mode) come from the server so there is one place to change them.
  // The server's clock is used for "now", because a visitor's own clock can be wrong.
  let configPromise = null;
  let skew = 0;
  function getConfig() {
    if (!configPromise) {
      configPromise = api('/api/config').then((cfg) => {
        skew = cfg.serverTime - Date.now();
        return cfg;
      });
      configPromise.catch(() => {
        configPromise = null; // allow another try
      });
    }
    return configPromise;
  }
  const now = () => Date.now() + skew;

  // ---- Building page elements --------------------------------------------------------------------
  function append(node, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }

  // h('div', { class: 'card', onclick: fn }, 'text', otherElement)
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    append(node, kids);
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // icon('car') draws the icon with that name from /img/icons.svg
  function icon(name, extraClass) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ico' + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '/img/icons.svg#' + name);
    svg.append(use);
    return svg;
  }

  // ---- Showing numbers and times --------------------------------------------------------------------
  const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rupees = (n) => '₹' + (Number.isInteger(n) ? inr0 : inr2).format(n);

  const two = (n) => (n < 10 ? '0' : '') + n;
  // 'HH:MM' on the lot clock, the form the server wants for a start time
  function lotTime(ms, cfg) {
    const p = S.lotParts(ms, cfg.utcOffsetMinutes);
    return two(p.h) + ':' + two(p.mi);
  }

  // 4:05 style countdown
  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(total / 60) + ':' + two(total % 60);
  }

  // "2 h 10 min"
  function duration(ms) {
    const mins = Math.max(0, Math.round(ms / S.MIN));
    const hrs = Math.floor(mins / 60);
    const rest = mins % 60;
    if (hrs && rest) return hrs + ' h ' + rest + ' min';
    if (hrs) return hrs + ' h';
    return rest + ' min';
  }

  // ---- The coloured strip that says when payments are not real -----------------------------------
  function applyModeBanner(cfg) {
    const bar = document.getElementById('mode-banner');
    if (!bar) return;
    const p = cfg.payments;
    let text = '';
    if (p.mode === 'demo') text = 'Payments are simulated on this computer, so no money is taken.';
    else if (p.mode === 'unavailable') text = 'Online booking is temporarily unavailable. Please check back soon.';
    else if (p.test) text = 'Razorpay test payments: use Razorpay’s test cards, no real money is taken.';
    bar.textContent = text;
    bar.hidden = !text;
  }

  // ---- Refreshing a page while it is visible -----------------------------------------------------------
  function poll(fn, everyMs) {
    let busy = false;
    async function tick() {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        await fn();
      } catch (err) {
        // the caller shows its own errors
      }
      busy = false;
    }
    setInterval(tick, everyMs);
    document.addEventListener('visibilitychange', tick);
    tick();
  }

  // ---- The vehicle number box (used on the booking and lookup pages) ----------------------------------------
  const EXAMPLE = 'For example MP 09 AB 1234 or 22 BH 1234 AA';
  function plateField(input, help, onChange) {
    let touched = false;
    let last; // the value we last reported: undefined until the first report
    function update() {
      const norm = S.normalizePlate(input.value);
      const ok = S.isValidPlate(norm);
      const showBad = touched && norm.length > 0 && !ok;
      input.classList.toggle('valid', ok);
      input.setAttribute('aria-invalid', showBad ? 'true' : 'false');
      help.className = 'help' + (ok ? ' good' : showBad ? ' bad' : '');
      help.textContent = ok ? 'Vehicle number ' + S.formatPlate(norm) : showBad ? 'That does not look like a vehicle number. ' + EXAMPLE + '.' : EXAMPLE + '.';
      const value = ok ? norm : null;
      // Only report real changes. Re-drawing the page when nothing changed (for example when the box loses focus
      // because the person is pressing a button) could swallow that button press.
      if (onChange && value !== last) {
        last = value;
        onChange(value);
      }
      return value;
    }
    input.addEventListener('input', update);
    input.addEventListener('blur', () => {
      touched = true;
      update();
    });
    update();
    return {
      value: () => (S.isValidPlate(S.normalizePlate(input.value)) ? S.normalizePlate(input.value) : null),
      // Call when the person presses the main button: shows the problem if there is one.
      validate() {
        touched = true;
        return update();
      },
      set(text) {
        input.value = text;
        update();
      },
    };
  }

  // Small things kept in this browser only, such as the last vehicle number used. Never needed for the site to work.
  const remember = {
    get(key) {
      try {
        return window.localStorage.getItem('bayfind.' + key);
      } catch (err) {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem('bayfind.' + key, value);
      } catch (err) {
        // private window or blocked storage: fine
      }
    },
  };

  // ---- Who is signed in -----------------------------------------------------------------------------------------
  let sessionPromise = null;
  // { role: 'admin' | 'official' | 'attendant' | 'customer', name, email, permissions } or null
  function session() {
    if (!sessionPromise) sessionPromise = api('/api/me').then((r) => r.user, () => null);
    return sessionPromise;
  }
  function refreshSession() {
    sessionPromise = null;
    return session();
  }
  // True when the signed-in person's role holds the permission (the server checks again on every request).
  async function can(permission) {
    const user = await session();
    return Boolean(user && Array.isArray(user.permissions) && user.permissions.includes(permission));
  }
  async function signOut() {
    try {
      await post('/api/auth/logout', {});
    } catch (err) {
      // the cookie may already be gone
    }
    await refreshSession();
    location.assign('/');
  }

  // The links "Sign in" or "My bookings" and "Sign out" (for the admin: Dashboard, Business and "Sign out") go at the
  // end of each page's main menu, just before the booking button.
  async function applyAuthNav() {
    const nav = document.querySelector('header .nav');
    if (!nav) return;
    const user = await session();
    nav.querySelectorAll('[data-auth]').forEach((node) => node.remove());
    const cta = nav.querySelector('.nav-cta');
    const add = (node) => nav.insertBefore(node, cta);
    const link = (href, text) => h('a', { class: 'nav-auth', href, 'data-auth': '' }, text);
    const has = (href) => nav.querySelector('a[href="' + href + '"]');
    if (!user) return add(link('/login', 'Sign in'));
    if (user.role === 'attendant') {
      // Gate staff see the scanner and nothing else of the owner's pages: the other links are taken out of the menu.
      nav.querySelectorAll('a').forEach((a) => {
        if (/^\/(dashboard|bookings|business|analytics|customers|officials)(\/|$)/.test(a.getAttribute('href') || '')) a.remove();
      });
      if (!has('/scan')) add(link('/scan', 'Scan QR'));
      const sub = document.querySelector('header .brand-sub');
      if (sub) sub.textContent = 'Gate';
    } else if (user.role === 'admin' || user.role === 'official') {
      if (!has('/dashboard')) add(link('/dashboard', 'Dashboard'));
      if (!has('/business')) add(link('/business', 'Business'));
      // Only the admin may scan customers in and out; the page and its requests are refused to everyone else.
      if (Array.isArray(user.permissions) && user.permissions.includes('gate:scan') && !has('/scan')) add(link('/scan', 'Scan QR'));
      // Only the owner manages the officials' logins; the officials' own pages are labelled for them.
      if (user.role === 'admin' && has('/analytics') && !has('/officials')) nav.insertBefore(h('a', { class: 'nav-auth', href: '/officials', 'data-auth': '' }, 'Officials'), has('/analytics').nextSibling);
      const sub = document.querySelector('header .brand-sub');
      if (sub && user.role === 'official') sub.textContent = 'Government';
    } else if (!has('/account')) {
      add(link('/account', 'My bookings'));
    }
    return add(h('button', { class: 'nav-auth nav-signout', type: 'button', 'data-auth': '', onclick: signOut }, 'Sign out'));
  }

  // A warning card for the admin: a vehicle past its booked time still sits on a bay that someone else has booked. When the
  // reader may move bookings (`canMove`), each free bay gets a button that sends the waiting booking there. `moved(message)` is
  // called after a move so the page can reload its lists.
  function bayWarning(w, { canMove, utcOffsetMinutes, moved, failed }) {
    const at = (ms) => S.formatTime(ms, utcOffsetMinutes);
    const waiting = w.level === 'waiting';
    const status = h('p', { class: 'fine', role: 'status' });
    const buttons = w.free.map((f) =>
      h(
        'button',
        {
          class: 'btn btn-navy btn-sm',
          type: 'button',
          onclick: async (event) => {
            const btn = event.currentTarget;
            btn.disabled = true;
            status.textContent = 'Moving…';
            try {
              const r = await post('/api/dashboard/bookings/' + encodeURIComponent(w.next.ref) + '/move-bay', { bay: f.bay });
              status.textContent = r.message;
              if (moved) moved(r.message);
            } catch (err) {
              btn.disabled = false;
              status.textContent = err.message;
              if (failed) failed(err);
            }
          },
        },
        `Move to bay ${f.bay}`
      )
    );
    return h(
      'div',
      { class: 'banner ' + (waiting ? 'bad' : 'warn') },
      h('b', null, waiting ? `Bay ${w.bay} is blocked. ` : `Bay ${w.bay} may be blocked soon. `),
      `${w.parked.plate} is still parked there, ${w.parked.overMinutes} min past its booked time (${at(w.parked.endMs)}). `,
      waiting
        ? `${w.next.plate} (booking ${w.next.ref}) booked this bay from ${at(w.next.startMs)} and is waiting for it. `
        : `${w.next.plate} (booking ${w.next.ref}) booked this bay from ${at(w.next.startMs)}, in ${w.next.minutesToStart} min. `,
      w.free.length
        ? canMove
          ? 'Send the waiting customer to a free bay:'
          : `Free bays for them: ${w.free.map((f) => f.bay).join(', ')}.`
        : 'No other bay of this kind is free for that time. Ask the parked customer to move their vehicle.',
      w.free.length && canMove ? h('div', { class: 'banner-actions' }, buttons) : null,
      status
    );
  }

  window.Bayfind = { S, ApiError, bayWarning, api, post, getConfig, now, append, h, icon, rupees, lotTime, clock, duration, applyModeBanner, poll, plateField, remember, session, refreshSession, can, signOut };

  // Every page shows the payment-mode strip and who is signed in.
  getConfig().then(applyModeBanner, () => {});
  applyAuthNav();
})();
