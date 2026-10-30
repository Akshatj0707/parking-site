/*
 * Home page: the live "free bays" card. The numbers come from the same check the booking page uses,
 * for the next time slot someone could book, so what you see here is what you get when you book.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h } = B;
  const status = document.getElementById('live-status');
  if (!status) return;

  let firstPaint = true;

  function show(vehicle, data) {
    const free = document.getElementById('free-' + vehicle);
    const fill = document.getElementById('fill-' + vehicle);
    const zones = document.getElementById('zones-' + vehicle);
    free.textContent = String(data.free);
    const share = data.total ? Math.round((data.free / data.total) * 100) : 0;
    // Let the bar grow from empty the first time it appears.
    const set = () => {
      fill.style.width = share + '%';
    };
    if (firstPaint) requestAnimationFrame(() => requestAnimationFrame(set));
    else set();
    zones.replaceChildren(...data.zones.map((z) => h('span', { class: 'zone-pill' }, z.name + ' ', h('b', null, String(z.free)))));
  }

  async function refresh() {
    let cfg;
    try {
      cfg = await B.getConfig();
    } catch (err) {
      status.textContent = 'Live availability is not available right now. You can still book a bay.';
      return;
    }
    const off = cfg.utcOffsetMinutes;
    const step = cfg.slotMinutes * S.MIN;
    const t = B.now();
    const earliest = t - cfg.startGraceMinutes * S.MIN;
    let start = S.slotFloor(earliest, off, cfg.slotMinutes);
    if (start < earliest) start += step;
    const date = S.lotDateString(start, off);
    const time = B.lotTime(start, cfg);
    const hours = cfg.hoursOptions[0];

    try {
      const [car, bike] = await Promise.all(
        S.VEHICLES.map((v) => B.api(`/api/availability?vehicle=${v}&date=${date}&time=${time}&hours=${hours}`))
      );
      show('car', car);
      show('bike', bike);
      firstPaint = false;
      status.textContent = `Free from ${S.formatTime(start, off)} for ${hours} hour${hours > 1 ? 's' : ''}. Updated ${S.formatTime(B.now(), off)}.`;
    } catch (err) {
      status.textContent = err.status === 429 ? 'Too many refreshes. Numbers will update in a moment.' : 'Could not refresh the numbers. Trying again soon.';
    }
  }

  B.poll(refresh, 30 * 1000);
})();
