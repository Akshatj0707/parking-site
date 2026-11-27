/*
 * The gate scanner for the admin's phone: opens the camera, reads the customer's entry or exit QR code and tells the server.
 *
 * The server decides what a scan means (see src/gate.js). This page reads the code, sends its text, and shows the answer in
 * big green, amber or red. A phone that cannot read QR codes itself uses the bundled jsQR; typing the booking reference or
 * the vehicle number works as well.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, rupees } = B;
  const $ = (id) => document.getElementById(id);

  const video = $('video');
  const hint = $('hint');
  const off = $('off');
  const resultBox = $('result');

  let stream = null;
  let detector = null; // the browser's own QR reader, when it has one
  let jsqr = null; // the bundled reader, loaded only when needed
  let timer = null;
  let busy = false; // a scan is being sent
  let lastText = ''; // the code that was read last, and when it was last in front of the camera: a code that stays in view
  let lastSeenAt = 0; // is scanned once, not again and again (that would flip a green card to "already scanned")
  let current = null; // the booking whose result is on screen
  let watch = null; // the timer that waits for a customer to pay
  let cfg = null;
  let canMove = false;
  let canWaive = false; // only the owner may drop a charge; gate staff may mark it collected
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const clock = (ms) => S.formatTime(ms, cfg ? cfg.utcOffsetMinutes : 330);

  // ---- Showing an answer ---------------------------------------------------------------------------------------
  function fact(label, value) {
    return h('div', null, h('dt', null, label), h('dd', null, value));
  }

  function resultCard(r) {
    const b = r.booking;
    const g = r.gate;
    const kids = [h('h2', null, r.title), b ? h('p', { class: 'plate' }, b.plate) : null, h('p', null, r.message)];
    if (b) kids.push(h('dl', { class: 'facts' }, fact('Bay', `${b.bay} · ${b.zone}`), fact('Vehicle', b.vehicleLabel), fact('Booked time', b.window), fact('Reference', b.ref)));
    const actions = [];
    if (g && g.stage === 'payment_due') {
      actions.push(
        h('button', { class: 'btn btn-navy', type: 'button', onclick: () => settle(b.ref, 'manual') }, 'Collected another way'),
        canWaive ? h('button', { class: 'btn btn-outline', type: 'button', onclick: () => settle(b.ref, 'waive') }, 'Waive the charge') : null
      );
    }
    actions.push(h('button', { class: 'btn btn-accent', type: 'button', onclick: clearResult }, 'Scan next'));
    kids.push(h('div', { class: 'actions' }, actions));
    return h('div', { class: 'scan-result ' + r.tone }, kids);
  }

  function show(r) {
    clearInterval(watch);
    current = r.booking ? r.booking.ref : null;
    resultBox.replaceChildren(resultCard(r));
    resultBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // a short buzz when a code was read (browsers only allow it after the person has touched the page)
    if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate(r.tone === 'ok' ? 80 : [80, 60, 80]);
    // an extra charge is waiting: look every few seconds so the screen turns green when the customer has paid
    if (r.gate && r.gate.stage === 'payment_due') {
      const ref = r.booking.ref;
      watch = setInterval(async () => {
        if (current !== ref) return clearInterval(watch);
        try {
          const s = await B.api('/api/dashboard/gate/status?ref=' + encodeURIComponent(ref));
          if (s.gate.stage === 'left') {
            clearInterval(watch);
            const ov = s.gate.overstay;
            show({ tone: 'ok', title: 'Paid. Let it go', message: ov && ov.status === 'paid' ? `The extra ${rupees(ov.amount)} was paid. The vehicle can leave.` : 'The vehicle can leave.', booking: s.booking, gate: s.gate });
            loadInside();
          }
        } catch (err) {
          // try again at the next tick
        }
      }, 3000);
    }
  }

  function showError(text) {
    show({ tone: 'bad', title: 'Not accepted', message: text, booking: null, gate: null });
  }

  function clearResult() {
    clearInterval(watch);
    current = null;
    resultBox.replaceChildren();
  }

  async function settle(ref, method) {
    const ask = method === 'waive' ? 'Waive the extra charge? The customer will not pay anything for the extra time.' : 'Mark the extra charge as collected another way (for example cash)?';
    if (!window.confirm(ask)) return;
    try {
      show(await B.post('/api/dashboard/gate/settle', { ref, method }));
      loadInside();
    } catch (err) {
      showError(err.message);
    }
  }

  // ---- Sending a scan ----------------------------------------------------------------------------------------------
  async function send(body) {
    if (busy) return;
    busy = true;
    hint.textContent = 'Checking…';
    try {
      show(await B.post('/api/dashboard/gate/scan', body));
      loadInside();
    } catch (err) {
      showError(err.message);
    } finally {
      busy = false;
      hint.textContent = stream ? 'Point the camera at a QR code' : '';
    }
  }

  // ---- The camera -------------------------------------------------------------------------------------------------------
  function loadJsQr() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (!jsqr) {
      jsqr = new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = '/js/vendor/jsQR.js';
        tag.onload = () => resolve(window.jsQR);
        tag.onerror = () => {
          jsqr = null;
          reject(new Error('The QR reader did not load.'));
        };
        document.head.append(tag);
      });
    }
    return jsqr;
  }

  async function pickReader() {
    if (detector) return;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (err) {
        detector = null;
      }
    }
    if (!detector) await loadJsQr();
  }

  async function read() {
    if (detector) {
      const codes = await detector.detect(video);
      return codes.length ? codes[0].rawValue : '';
    }
    const w = video.videoWidth;
    const hgt = video.videoHeight;
    if (!w || !hgt) return '';
    const scale = Math.min(1, 640 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(hgt * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(data.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
    return code ? code.data : '';
  }

  function tick() {
    timer = setTimeout(async () => {
      if (!stream) return;
      if (!busy && video.readyState >= 2) {
        try {
          const text = await read();
          if (text) {
            const again = text === lastText && Date.now() - lastSeenAt < 2000;
            lastSeenAt = Date.now();
            if (!again) {
              lastText = text;
              await send({ token: text });
              lastSeenAt = Date.now();
            }
          }
        } catch (err) {
          // a frame that cannot be read is skipped
        }
      }
      tick();
    }, 180);
  }

  function cameraOff(text) {
    stopCamera();
    $('off-text').textContent = text;
    off.hidden = false;
    hint.textContent = '';
  }

  function stopCamera() {
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  async function startCamera() {
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return cameraOff('This browser cannot open the camera here. Open this page in Chrome or Safari on your phone, over https. You can type the booking reference below meanwhile.');
    }
    hint.textContent = 'Starting the camera…';
    try {
      await pickReader();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      off.hidden = true;
      hint.textContent = 'Point the camera at a QR code';
      tick();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      cameraOff(denied ? 'The camera is blocked. Allow the camera for this website in your browser settings, then press Start camera.' : 'The camera could not be started. Press Start camera to try again, or type the booking reference below.');
    }
  }

  // ---- Typing a reference or a vehicle number ----------------------------------------------------------------------------
  let typedKind = 'ref';
  function setKind(kind) {
    typedKind = kind;
    $('by-ref').setAttribute('aria-pressed', String(kind === 'ref'));
    $('by-plate').setAttribute('aria-pressed', String(kind === 'plate'));
    $('typed-label').textContent = kind === 'ref' ? 'Booking reference' : 'Vehicle number';
    $('typed').placeholder = kind === 'ref' ? 'For example K7M2QX' : 'MP 09 AB 1234';
    $('typed').focus();
  }
  $('by-ref').addEventListener('click', () => setKind('ref'));
  $('by-plate').addEventListener('click', () => setKind('plate'));

  let action = 'in';
  document.querySelectorAll('#manual button[type="submit"]').forEach((btn) => btn.addEventListener('click', () => (action = btn.dataset.action)));
  $('manual').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('typed').value.trim();
    if (!value) return showError('Type a booking reference or a vehicle number first.');
    send(typedKind === 'ref' ? { ref: value, action } : { plate: value, action });
  });

  // ---- Who is inside ----------------------------------------------------------------------------------------------------
  async function loadInside() {
    let data;
    try {
      data = await B.api('/api/dashboard/gate/inside');
    } catch (err) {
      return;
    }
    $('blocked').replaceChildren(...(data.warnings || []).map((w) => B.bayWarning(w, { canMove, utcOffsetMinutes: cfg ? cfg.utcOffsetMinutes : 330, moved: () => loadInside() })));
    $('inside-count').textContent = data.count === 0 ? 'Nobody is inside right now.' : data.count + (data.count === 1 ? ' vehicle' : ' vehicles');
    $('inside').replaceChildren(
      ...data.vehicles.map(({ booking, gate }) => {
        const tag = gate.stage === 'payment_due' ? ['pay', 'Waiting to pay'] : gate.stage === 'overstaying' ? ['over', `Over by ${gate.estimate.overMinutes} min`] : ['', 'Inside'];
        return h(
          'li',
          null,
          h('span', { class: 'where' }, h('span', { class: 'plate' }, booking.plate), h('span', { class: 'fine' }, `Bay ${booking.bay} · in at ${clock(gate.entryAt)} · until ${clock(booking.endMs)}`)),
          h('span', { class: 'tag ' + tag[0] }, tag[1])
        );
      })
    );
  }

  // ---- Start ----------------------------------------------------------------------------------------------------------------
  $('start').addEventListener('click', startCamera);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopCamera();
    else if (off.hidden) startCamera();
  });

  async function init() {
    cfg = await B.getConfig().catch(() => null);
    canMove = await B.can('bookings:move-bay').catch(() => false);
    canWaive = await B.can('gate:waive').catch(() => false);
    loadInside();
    setInterval(() => document.visibilityState === 'visible' && loadInside(), 20000);
    // A normal phone camera opens the address inside the QR code, /scan?t=..., and that is handled here as a scan.
    const t = new URLSearchParams(window.location.search).get('t');
    if (t) {
      window.history.replaceState(null, '', '/scan');
      await send({ token: t });
    }
    startCamera();
  }
  init();
})();
