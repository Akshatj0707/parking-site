'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const S = require('../public/js/shared.js');
const { HttpError } = require('./errors');
const { HitCounter, createLimiter } = require('./ratelimit');
const { createBookingService } = require('./bookings');
const { verifyWebhookSignature } = require('./payments');
const { RENDER_DISK_PATH } = require('./config');
const { describeWeek } = require('./words');
const { createChat } = require('./chat');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The only pages the site serves. Each one is plain HTML with {{TOKENS}} that are filled in from the settings.
const PAGES = { '/': 'index.html', '/book': 'book.html', '/lookup': 'lookup.html', '/dashboard': 'dashboard.html' };
// The policy pages. Razorpay looks for these before it switches a shop to live payments. The words of each page are in
// public/legal/<name>.html; public/legal.html wraps them in the site's header and footer. The footer links come from
// this list, in this order.
const LEGAL_PAGES = {
  '/pricing': { body: 'legal/pricing.html', eyebrow: 'Pricing', title: 'Pricing', footer: 'Pricing', description: 'What parking costs, in rupees, and how the total is worked out.' },
  '/terms': { body: 'legal/terms.html', eyebrow: 'Policies', title: 'Terms of use', footer: 'Terms', description: 'The rules for booking a bay on this website.' },
  '/privacy': { body: 'legal/privacy.html', eyebrow: 'Policies', title: 'Privacy policy', footer: 'Privacy', description: 'What we keep when you book, why, and who else sees it.' },
  '/refunds': { body: 'legal/refunds.html', eyebrow: 'Policies', title: 'Cancellation and refund policy', footer: 'Cancellation and refunds', description: 'How to cancel a booking, and how and when refunds are paid.' },
  '/shipping': { body: 'legal/shipping.html', eyebrow: 'Policies', title: 'Shipping and delivery', footer: 'Shipping and delivery', description: 'Nothing is posted to you. This is how your booking reaches you.' },
  '/contact': { body: 'legal/contact.html', eyebrow: 'Contact', title: 'Contact us', footer: 'Contact', description: 'Who runs this parking lot and how to reach us.' },
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Express 4 does not catch errors from async handlers by itself.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

const FOOTER_NAV = [
  '<div class="foot-links">',
  '      <nav aria-label="Footer">',
  '        <a href="/book">Book a bay</a>',
  '        <a href="/lookup">Find my booking</a>',
  '        <a href="/dashboard">Operator</a>',
  '      </nav>',
  '      <nav aria-label="Policies">',
  ...Object.entries(LEGAL_PAGES).map(([route, page]) => `        <a href="${route}">${escapeHtml(page.footer)}</a>`),
  '      </nav>',
  '    </div>',
].join('\n');

// "tel:" links keep only the digits and the plus sign: "+91 98765-43210" becomes "tel:+919876543210".
const phoneLink = (phone) => `<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">${escapeHtml(phone)}</a>`;
const emailLink = (email) => `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;

// "Email x or call y." with whatever has been set. Used wherever a page says "contact us".
function supportLine(config) {
  const email = config.supportEmail ? emailLink(config.supportEmail) : '';
  const phone = config.supportPhone ? phoneLink(config.supportPhone) : '';
  if (email && phone) return `Email ${email} or call ${phone}.`;
  if (email) return `Email ${email}.`;
  if (phone) return `Call ${phone}.`;
  return 'Ask at the parking office.';
}

// The details on the Contact page: only the ones that have been set.
function contactList(config) {
  const rows = [['Business name', escapeHtml(config.businessName)]];
  if (config.businessAddress) rows.push(['Address', escapeHtml(config.businessAddress)]);
  if (config.supportPhone) rows.push(['Phone', phoneLink(config.supportPhone)]);
  if (config.supportEmail) rows.push(['Email', emailLink(config.supportEmail)]);
  if (rows.length === 1) rows.push(['How to reach us', 'Ask at the parking office.']);
  return `<dl class="contact-list">${rows.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

// What the privacy page says about the chat window. It changes with the settings, so it is always true: the section is
// left out when the chat is off, and it says that Anthropic gets the questions only when an AI key is set.
function chatPrivacy(config) {
  if (!config.chat.enabled) return { section: '', sharing: '' };
  const ai = config.chat.ai;
  const section = [
    '<h2>Chat assistant</h2>',
    '    <p>This website has a chat window for questions about parking, prices and bookings. Please do not type card numbers, passwords or other secrets into it. The conversation stays in your browser tab and is gone when you close the tab. We do not save what you type in the chat on our server, and it is never added to your booking.</p>',
    ai
      ? '    <p>To write an answer, our server sends what you typed in the chat, together with the last few messages of the same chat, to Anthropic, the company that makes the Claude AI model. Anthropic handles that text under its own privacy policy. If the AI cannot be reached, a simple built-in answer is given instead and nothing is sent to Anthropic. The assistant can make mistakes, so check prices and times on the booking page.</p>'
      : '    <p>The answers are made by our own server from the prices and bay counts on this website. What you type in the chat is not sent to anyone else.</p>',
  ].join('\n');
  const sharing = ai ? '<li><strong>Anthropic</strong> writes the answers of the chat assistant, using what you type in the chat (see “Chat assistant” below).</li>' : '';
  return { section, sharing };
}

// Fills the {{TOKENS}} in a page. The files are read on every request, so edits show up after a refresh.
// A policy page is filled in twice: first its own words, then the page around them.
function createPageRenderer(config, now) {
  const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const fill = (html, tokens) => html.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in tokens ? tokens[key] : whole));
  return (file, legal = null) => {
    const car = S.LOT.car;
    const bike = S.LOT.bike;
    const week = describeWeek(config);
    const chat = chatPrivacy(config);
    const tokens = {
      CHAT_PRIVACY: chat.section,
      CHAT_SHARING: chat.sharing,
      SITE_NAME: escapeHtml(config.siteName),
      LOGO_LETTER: escapeHtml(config.siteName.charAt(0).toUpperCase()),
      YEAR: String(S.lotParts(now(), config.utcOffsetMinutes).y),
      SUPPORT_LINE: supportLine(config),
      BUSINESS_NAME: escapeHtml(config.businessName),
      CONTACT_LIST: contactList(config),
      FOOTER_NAV,
      RATE_CAR_WEEKDAY: String(config.rates.car.weekday),
      RATE_CAR_WEEKEND: String(config.rates.car.weekend),
      RATE_BIKE_WEEKDAY: String(config.rates.bike.weekday),
      RATE_BIKE_WEEKEND: String(config.rates.bike.weekend),
      WEEKDAY_TEXT: week.weekday,
      WEEKEND_TEXT: week.weekend,
      CAR_TOTAL: String(car.total),
      BIKE_TOTAL: String(bike.total),
      TOTAL_BAYS: String(car.total + bike.total),
      CAR_ZONE_COUNT: String(car.zones.length),
      BIKE_ZONE_COUNT: String(bike.zones.length),
      CAR_PER_ZONE: String(car.perZone),
      BIKE_PER_ZONE: String(bike.perZone),
      HOURS_MIN: String(config.hoursOptions[0]),
      HOURS_MAX: String(config.hoursOptions[config.hoursOptions.length - 1]),
      HOLD_MINUTES: String(config.holdMinutes),
      MAX_ADVANCE_DAYS: String(config.maxAdvanceDays),
    };
    if (legal) {
      tokens.PAGE_EYEBROW = escapeHtml(legal.eyebrow);
      tokens.PAGE_TITLE = escapeHtml(legal.title);
      tokens.PAGE_DESCRIPTION = escapeHtml(legal.description);
      tokens.PAGE_BODY = fill(read(legal.body), tokens);
    }
    return fill(read(file), tokens);
  };
}

function securityHeaders(config) {
  // Razorpay Checkout needs its script, its popup frame and a few calls home, all on razorpay.com. Everything else
  // stays on this site. (If a browser ever blocks something Razorpay needs, its console says "Refused to ...":
  // add that address here, or set DISABLE_CSP=1 while you find out which one.)
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://*.razorpay.com",
    "style-src 'self' 'unsafe-inline' https://*.razorpay.com",
    "img-src 'self' data: https:",
    "font-src 'self' data: https://*.razorpay.com",
    "connect-src 'self' https://*.razorpay.com",
    'frame-src https://*.razorpay.com',
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    if (!config.disableCsp) res.set('Content-Security-Policy', csp);
    if (config.production && req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  };
}

// ---- Setup check (operator only) -------------------------------------------------------------------------------
// Behind a hosting platform every visitor reaches the site through the platform's own servers, so the site has to be
// told how many of them to look through (TRUST_PROXY) to find the visitor's real address. Too few and many visitors
// share one address, so the limits on each visitor are shared too. Too many and a visitor can make up the address.
// This lists, for each possible number, the address the site would then see, so the right number is the lowest one
// whose row shows the operator's own address (found on any "what is my IP address" website).
const clip = (value) => String(value).slice(0, 100);

function connectionReport(req, config, store, chat) {
  // The list Express works from: the machine that connected (the platform's server), then the X-Forwarded-For
  // addresses from the right, which is the order in which each proxy added the one before it.
  const header = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  const forwarded = header.split(',').map((s) => s.replace(/^ +| +$/g, '')).filter(Boolean).reverse();
  const chain = [req.socket.remoteAddress || 'unknown', ...forwarded].slice(0, 8);
  return {
    address: clip(req.ip || 'unknown'),
    trustProxy: config.trustProxy === false ? null : config.trustProxy,
    connection: clip(chain[0]),
    forwardedFor: header ? clip(header) : null,
    options: chain.map((address, trust) => ({ trust, address: clip(address) })),
    secure: req.secure,
    forwardedProto: req.headers['x-forwarded-proto'] ? clip(req.headers['x-forwarded-proto']) : null,
    storage: {
      folder: config.dataDir,
      onRender: config.onRender,
      onDisk: config.dataOnRenderDisk,
      diskPath: config.onRender ? RENDER_DISK_PATH : null,
      bookings: store.bookings.length,
    },
    chat: chat.status(),
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

// `chat` lets the tests swap in a pretend Anthropic (fetchImpl, apiUrl, timeoutMs). The real site never passes it.
function createApp({ config, store, razorpay = null, now = Date.now, log = console, chat: chatOptions = {} }) {
  const bookings = createBookingService({ config, store, razorpay, now, log });
  const chat = createChat({ config, bookings, now, log, ...chatOptions });
  const renderPage = createPageRenderer(config, now);
  const app = express();
  app.locals.bookings = bookings;
  app.locals.chat = chat;
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config));

  const lookupLimit = createLimiter({ windowMs: 60 * 1000, max: 20, message: 'Too many searches. Please wait a minute and try again.' });
  const availabilityLimit = createLimiter({ windowMs: 60 * 1000, max: 120 });
  const checkoutLimit = createLimiter({ windowMs: 10 * 60 * 1000, max: 20, message: 'Too many booking attempts. Please wait a few minutes and try again.' });
  const verifyLimit = createLimiter({ windowMs: 60 * 1000, max: 30 });
  const chatLimit = createLimiter({ windowMs: 60 * 1000, max: 15, message: 'You are sending messages too fast. Please wait a moment and try again.' });

  // ---- Razorpay webhook. It must read the raw body, because the signature covers the exact bytes. ----
  app.post(
    '/api/razorpay/webhook',
    express.raw({ type: () => true, limit: '200kb' }),
    wrap(async (req, res) => {
      const secret = config.razorpay.webhookSecret;
      if (!secret) return res.status(404).json({ error: 'not_found' });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyWebhookSignature(secret, raw, req.get('X-Razorpay-Signature'))) {
        return res.status(400).json({ error: 'bad_signature' });
      }
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        return res.status(400).json({ error: 'bad_json' });
      }
      const result = await bookings.handleWebhook(event);
      return res.json({ ok: true, ...result });
    })
  );

  // Every request body is read as JSON and may be up to 10 kB, except a chat: it carries the conversation so far, which
  // can be longer (and is typed in any language, so a letter may take 3 bytes).
  const smallJson = express.json({ limit: '10kb' });
  const chatJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => (req.path === '/api/chat' ? next() : smallJson(req, res, next)));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ---- Public API ------------------------------------------------------------------------------
  app.get('/api/config', (req, res) => {
    const mode = bookings.paymentMode;
    res.json({
      siteName: config.siteName,
      supportEmail: config.supportEmail || null,
      serverTime: now(),
      utcOffsetMinutes: config.utcOffsetMinutes,
      weekendDays: config.weekendDays,
      rates: config.rates,
      hoursOptions: config.hoursOptions,
      slotMinutes: config.slotMinutes,
      startGraceMinutes: config.startGraceMinutes,
      maxAdvanceDays: config.maxAdvanceDays,
      holdMinutes: config.holdMinutes,
      lot: S.LOT,
      payments: { mode, keyId: mode === 'razorpay' ? config.razorpay.keyId : null, test: !config.razorpay.live },
      chat: chat.info(),
    });
  });

  // The chat window. The body is { messages: [{ role, content }, ...] } and the answer is { reply, actions, cards, mode }.
  app.post(
    '/api/chat',
    chatLimit,
    chatJson,
    wrap(async (req, res) => {
      res.json(await chat.reply(req.body, { visitor: req.ip }));
    })
  );

  app.get('/api/availability', availabilityLimit, (req, res) => {
    res.json(bookings.availability(req.query));
  });

  app.post(
    '/api/bookings',
    checkoutLimit,
    wrap(async (req, res) => {
      res.status(201).json(await bookings.startCheckout(req.body));
    })
  );

  const sendSettlement = (res, result) => {
    const { outcome, booking } = result;
    if (outcome === 'paid') return res.json({ status: 'paid', booking: bookings.view(booking) });
    return res.status(409).json({
      error: 'slot_lost',
      status: outcome,
      message: bookings.lostMessage(result),
      paymentId: outcome === 'refund_failed' ? booking.paymentId : undefined,
    });
  };

  app.post(
    '/api/payments/verify',
    verifyLimit,
    wrap(async (req, res) => {
      sendSettlement(res, await bookings.confirmCheckout(req.body));
    })
  );

  app.post(
    '/api/payments/demo-confirm',
    verifyLimit,
    wrap(async (req, res) => {
      const id = req.body && req.body.bookingId;
      if (typeof id !== 'string' || !/^bk_[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'invalid_booking', 'That booking id is not valid.');
      sendSettlement(res, await bookings.confirmDemo(id));
    })
  );

  app.post('/api/bookings/:id/release', verifyLimit, (req, res) => {
    if (!/^bk_[0-9a-f]{16}$/.test(req.params.id)) throw new HttpError(400, 'invalid_booking', 'That booking id is not valid.');
    bookings.release(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/bookings/lookup', lookupLimit, (req, res) => {
    res.json(bookings.lookup(req.query.plate));
  });

  // ---- Operator area: protected by a user name and password ---------------------------------------
  const wrongPasswords = new HitCounter(60 * 1000, now);
  function operatorGate(req, res, next) {
    const { user, password } = config.operator;
    res.set('Cache-Control', 'no-store');
    if (!password) {
      if (config.production) {
        return res.status(503).type('text/plain').send('The operator dashboard is switched off until OPERATOR_PASSWORD is set in the server settings.');
      }
      return next(); // on your own computer the dashboard is open, so it is easy to try
    }
    const who = req.ip || 'unknown';
    const earlier = wrongPasswords.current(who);
    if (earlier && earlier.count >= 10) {
      res.set('Retry-After', '60');
      return res.status(429).type('text/plain').send('Too many wrong passwords. Wait a minute and try again.');
    }
    const header = req.get('Authorization');
    if (header) {
      // Only a wrong password counts against the limit. A request with no password just gets asked for one.
      const match = /^Basic\s+(.+)$/i.exec(header);
      if (match) {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon !== -1 && sameSecret(decoded.slice(0, colon), user) && sameSecret(decoded.slice(colon + 1), password)) return next();
      }
      wrongPasswords.hit(who);
    }
    res.set('WWW-Authenticate', 'Basic realm="Parking operator", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Sign in with the operator user name and password.');
  }

  app.get('/api/dashboard', operatorGate, (req, res) => {
    res.json({ ...bookings.dashboard(), operatorProtected: Boolean(config.operator.password) });
  });

  // A browser remembers the dashboard password and sends it with every request to this site, even a request that
  // another website's page started. So a button that changes something is accepted only when it was pressed on
  // this site's own page. Browsers cannot send a JSON request to another site without a permission this site never
  // gives, and they say where a request came from, so those two things are checked.
  function ownPagesOnly(req, res, next) {
    const fetchSite = req.get('Sec-Fetch-Site');
    const origin = req.get('Origin');
    let fromThisSite = true; // no Origin at all means it is not a browser page (for example curl)
    if (fetchSite) {
      fromThisSite = fetchSite === 'same-origin';
    } else if (origin) {
      const hosts = [req.get('Host')];
      if (config.trustProxy !== false && req.get('X-Forwarded-Host')) hosts.push(req.get('X-Forwarded-Host').split(',')[0].trim());
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch (err) {
        // "null" or something unreadable: not from this site
      }
      fromThisSite = originHost !== null && hosts.includes(originHost);
    }
    const isJson = /^application\/json\b/i.test(String(req.get('Content-Type') || ''));
    if (!fromThisSite || !isJson) {
      return res.status(403).json({ error: 'forbidden', message: 'That request did not come from the dashboard page.' });
    }
    return next();
  }

  const operatorLimit = createLimiter({ windowMs: 60 * 1000, max: 60 });

  // Find the bookings of one vehicle number that the operator can cancel or retry a refund for.
  app.get('/api/dashboard/bookings', operatorGate, operatorLimit, (req, res) => {
    res.json(bookings.operatorFind(req.query.plate));
  });

  // The "Setup check" on the dashboard. It only reports on the request that asked: nothing secret, nothing about anyone else.
  app.get('/api/dashboard/connection', operatorGate, operatorLimit, (req, res) => {
    res.json(connectionReport(req, config, store, chat));
  });

  // Cancel a paid booking and refund it in full (or try a failed refund again).
  app.post(
    '/api/dashboard/bookings/:ref/cancel',
    operatorGate,
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      const ref = String(req.params.ref).toUpperCase();
      if (!/^[A-Z0-9]{6,12}$/.test(ref)) throw new HttpError(400, 'invalid_ref', 'That booking reference is not valid.');
      const { outcome, booking, message } = await bookings.operatorCancel(ref);
      const row = bookings.operatorRow(booking);
      if (outcome === 'refund_failed') return res.status(502).json({ error: 'refund_failed', message, booking: row });
      return res.json({ ok: true, outcome, message, booking: row });
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- Pages and files ---------------------------------------------------------------------------
  for (const [route, file] of Object.entries(PAGES)) {
    const gate = route === '/dashboard' ? [operatorGate] : [];
    app.get(route, ...gate, (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(renderPage(file));
    });
  }

  for (const [route, legal] of Object.entries(LEGAL_PAGES)) {
    app.get(route, (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(renderPage('legal.html', legal));
    });
  }

  app.get('/favicon.svg', (req, res) => {
    const letter = escapeHtml(config.siteName.charAt(0).toUpperCase());
    res.type('image/svg+xml').send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#1b3fd8"/><text x="32" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="38" font-weight="800" fill="#fff">${letter}</text></svg>`
    );
  });
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // Only these folders are public. The HTML pages are served by the routes above, never as raw files.
  for (const folder of ['css', 'js', 'img', 'fonts']) {
    app.use('/' + folder, express.static(path.join(PUBLIC_DIR, folder), { index: false }));
  }

  // ---- Not found and errors --------------------------------------------------------------------------
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found', message: 'Not found.' });
    return res
      .status(404)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title>` +
          `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5"><h1>Page not found</h1><p>That page does not exist.</p><p><a href="/">Back to ${escapeHtml(config.siteName)}</a></p>`
      );
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'The request could not be read.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'The request is too large.' });
    log.error(`Unexpected error on ${req.method} ${req.path}:`, err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
