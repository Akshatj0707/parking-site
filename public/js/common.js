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
    if (p.mode === 'demo') text = 'Test mode: payments are simulated, so no money is taken.';
    else if (p.mode === 'unavailable') text = 'Online booking is switched off until payments are set up.';
    else if (p.test) text = 'Test mode: payments use Razorpay test cards, so no real money is taken.';
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
  const EXAMPLE = 'For example MP 09 AB 1234';
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
  // { role: 'admin' | 'customer', name, email } or null
  function session() {
    if (!sessionPromise) sessionPromise = api('/api/me').then((r) => r.user, () => null);
    return sessionPromise;
  }
  function refreshSession() {
    sessionPromise = null;
    return session();
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

  // The links "Sign in" or "My bookings" and "Sign out" (for the operator: Dashboard, Analytics and "Sign out") go at the
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
    if (user.role === 'admin') {
      if (!has('/dashboard')) add(link('/dashboard', 'Dashboard'));
      if (!has('/analytics')) add(link('/analytics', 'Analytics'));
    } else if (!has('/account')) {
      add(link('/account', 'My bookings'));
    }
    return add(h('button', { class: 'nav-auth nav-signout', type: 'button', 'data-auth': '', onclick: signOut }, 'Sign out'));
  }

  window.Bayfind = { S, ApiError, api, post, getConfig, now, append, h, icon, rupees, lotTime, clock, duration, applyModeBanner, poll, plateField, remember, session, refreshSession, signOut };

  // Every page shows the payment-mode strip and who is signed in.
  getConfig().then(applyModeBanner, () => {});
  applyAuthNav();
})();
