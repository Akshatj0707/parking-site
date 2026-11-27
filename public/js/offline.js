/*
 * The offline page: lists the passes this phone has saved (the service worker keeps the last answer of /api/pass for each
 * pass that was opened) so the customer can open one with no signal. Everything is read from the phone's own cache and
 * shown as text.
 */
(function () {
  'use strict';

  const { h } = window.Bayfind;
  const PASSES = 'bayfind-pass-v1'; // the same name as in sw.js
  const box = document.getElementById('saved');

  document.getElementById('retry').addEventListener('click', () => window.location.reload());
  // The browser says it is back online. Reload only if the server really answers (the browser can be wrong about this).
  window.addEventListener('online', () => {
    fetch('/healthz', { cache: 'no-store' }).then((res) => res.ok && window.location.reload(), () => {});
  });

  async function savedPasses() {
    if (!('caches' in window)) return [];
    const cache = await caches.open(PASSES);
    const list = [];
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/pass') continue;
      try {
        const data = await (await cache.match(request)).json();
        if (data && data.booking) list.push({ token: url.searchParams.get('t'), booking: data.booking, savedAt: data.serverTime, offset: data.utcOffsetMinutes });
      } catch (err) {
        // a damaged copy is skipped
      }
    }
    return list.filter((p) => p.token).sort((a, b) => b.booking.startMs - a.booking.startMs);
  }

  savedPasses().then(
    (list) => {
      if (!list.length) {
        box.replaceChildren(h('p', { class: 'muted' }, 'No pass is saved on this phone yet. Open your pass once while you are online and it will be saved here.'));
        return;
      }
      box.replaceChildren(
        h('h2', { class: 'sub-h' }, 'Passes saved on this phone'),
        h('ul', { class: 'plain-list' }, ...list.map((p) =>
          h('li', null, h('a', { class: 'btn btn-outline', href: '/pass?t=' + encodeURIComponent(p.token) }, `${p.booking.plate} · bay ${p.booking.bay}`), ' ', h('span', { class: 'muted' }, p.booking.window)))));
    },
    () => box.replaceChildren(h('p', { class: 'muted' }, 'Saved passes could not be read on this phone.'))
  );
})();
