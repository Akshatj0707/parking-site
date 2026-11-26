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
const { createAuth, normalizeEmail } = require('./auth');
const { createGate, qrSvg } = require('./gate');
const { createInvoices } = require('./invoice');
const { createMailer, cancellationEmail, customerCancelEmail, passwordResetEmail, maskEmail } = require('./mail');
const { createReminders } = require('./reminders');
const roles = require('./roles');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The only pages the site serves. Each one is plain HTML with {{TOKENS}} that are filled in from the settings.
const PAGES = {
  '/': 'index.html',
  '/book': 'book.html',
  '/lookup': 'lookup.html',
  '/dashboard': 'dashboard.html',
  '/analytics': 'analytics.html',
  '/business': 'business.html',
  '/bookings': 'bookings.html',
  '/customers': 'customers.html',
  '/officials': 'officials.html',
  '/scan': 'scan.html',
  '/pass': 'pass.html',
  '/login': 'auth.html',
  '/signup': 'auth.html',
  '/account': 'auth.html',
  '/forgot-password': 'auth.html',
  '/reset-password': 'auth.html',
};
// Pages for the staff: the owner (admin) and government officials. The Officials page is for the owner alone.
const ADMIN_PAGES = new Set(['/dashboard', '/analytics', '/business', '/bookings', '/customers', '/officials', '/scan']);
// What a signed-in staff member needs to hold to open each staff page (the owner holds all of them; a gate attendant only /scan).
const PAGE_PERMISSION = {
  '/dashboard': 'bookings:view-all',
  '/bookings': 'bookings:view-all',
  '/customers': 'customers:view',
  '/analytics': 'analytics:view',
  '/business': 'analytics:view',
  '/officials': 'accounts:manage',
  '/scan': 'gate:scan',
};
const STAFF_ROLES = new Set(['admin', 'official', 'attendant']);
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
  '        <a href="/login">Sign in</a>',
  '        <a href="/signup">Create account</a>',
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
  const who = config.chat.provider === 'openai' ? escapeHtml(config.chat.providerLabel || 'the AI service') : 'Anthropic, the company that makes the Claude AI model';
  const section = [
    '<h2>Chat assistant</h2>',
    '    <p>This website has a chat window for questions about parking, prices and bookings. Please do not type card numbers, passwords or other secrets into it. The conversation stays in your browser tab and is gone when you close the tab. We do not save what you type in the chat on our server, and it is never added to your booking.</p>',
    ai
      ? `    <p>To write an answer, our server sends what you typed in the chat, together with the last few messages of the same chat, to ${who}. ${who} handles that text under its own privacy policy. If the AI cannot be reached, a simple built-in answer is given instead and nothing is sent to ${who}. The assistant can make mistakes, so check prices and times on the booking page.</p>`
      : '    <p>The answers are made by our own server from the prices and bay counts on this website. What you type in the chat is not sent to anyone else.</p>',
  ].join('\n');
  const sharing = ai ? `<li><strong>${config.chat.provider === 'openai' ? escapeHtml(config.chat.providerLabel || 'The AI service') : 'Anthropic'}</strong> writes the answers of the chat assistant, using what you type in the chat (see “Chat assistant” below).</li>` : '';
  return { section, sharing };
}

// Fills the {{TOKENS}} in a page. The files are read on every request, so edits show up after a refresh.
// A policy page is filled in twice: first its own words, then the page around them.
function createPageRenderer(config, now) {
  const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const fill = (html, tokens) => html.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in tokens ? tokens[key] : whole));
  return (file, legal = null, extra = null) => {
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
      CANCEL_FREE_HOURS: String(config.cancel.freeHours),
      CANCEL_GRACE_MINUTES: String(config.cancel.graceMinutes),
      CANCEL_LATE_PERCENT: String(config.cancel.lateRefundPercent),
      EXTEND_MAX_HOURS: String(config.extend.maxHours),
      EXTEND_MAX_TOTAL_HOURS: String(config.extend.maxTotalHours),
      MAX_ADVANCE_DAYS: String(config.maxAdvanceDays),
      NO_SHOW_MINUTES: String(config.gate.noShowMinutes),
      NO_SHOW_TEXT: config.gate.noShowMinutes > 0
        ? `If your vehicle has not been scanned in ${config.gate.noShowMinutes} minutes after the start, the bay is released for other customers and the amount is not refunded. If you come later and the bay is still free, you can still park.`
        : 'Your bay is kept for the whole time you booked, even if you arrive late.',
    };
    if (extra) Object.assign(tokens, extra); // the caller escapes these
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
      kind: config.database.enabled ? 'database' : 'files',
      database: config.database.enabled ? config.database.host : null,
      databaseError: store.syncError,
      folder: config.database.enabled ? null : config.dataDir,
      onRender: config.onRender,
      onDisk: config.database.enabled ? null : config.dataOnRenderDisk,
      diskPath: config.onRender && !config.database.enabled ? RENDER_DISK_PATH : null,
      bookings: store.bookings.length,
    },
    chat: chat.status(),
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

// `chat` lets the tests swap in a pretend Anthropic (fetchImpl, apiUrl, timeoutMs). The real site never passes it.
// `storage` (from storage.js) carries the customer accounts and the sign-in key when they live in the database. Without it
// they are kept in files next to the bookings, which is what the tests and a computer at home use.
function createApp({ config, store, razorpay = null, now = Date.now, log = console, chat: chatOptions = {}, storage = null, mail: mailOptions = {} }) {
  const bookings = createBookingService({ config, store, razorpay, now, log });
  if (storage && storage.kind === 'database') bookings.adopt = () => storage.adopt();
  const chat = createChat({ config, bookings, now, log, ...chatOptions });
  const auth = createAuth({ config, now, log, storage });
  // The entry and exit QR codes. The booking service asks it for a booking's pass page and hands it the payments that are
  // for extra parking time.
  const gate = createGate({ config, bookings, razorpay, now, log, signFor: auth.signFor });
  bookings.passPath = (b) => gate.passPath(b);
  const invoices = createInvoices({ config, bookings, signFor: auth.signFor, userById: (id) => auth.users.byId(id), now });
  bookings.invoicePath = (b) => (invoices.eligibility(b).ok ? '/invoice?t=' + gate.tokenFor('pass', b) : null);
  bookings.overstayWebhook = (payment) => gate.handleWebhook(payment);
  bookings.overstayReconcile = () => gate.reconcile();
  const mailer = createMailer({ config, log, ...mailOptions });
  const reminders = createReminders({ config, bookings, gate, auth, mailer, log, now });
  const renderPage = createPageRenderer(config, now);
  const app = express();
  app.locals.bookings = bookings;
  app.locals.chat = chat;
  app.locals.auth = auth;
  app.locals.gate = gate;
  app.locals.invoices = invoices;
  app.locals.reminders = reminders;
  app.locals.mailer = mailer;
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
      payments: { mode, reason: bookings.unavailableReason, keyId: mode === 'razorpay' ? config.razorpay.keyId : null, test: !config.razorpay.live },
      chat: chat.info(),
      auth: {
        loginRequired: config.auth.customerLoginRequired,
        // false on a host that forgets its files at every restart: accounts and bookings are then lost with them
        persistent: config.dataOnRenderDisk !== false,
        passwordReset: mailer.enabled, // a customer can get a link to choose a new password by email
        testCustomer: config.auth.seedTestCustomer ? { email: auth.TEST_CUSTOMER.email, password: auth.TEST_CUSTOMER.password } : null,
      },
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
      const session = auth.current(req);
      if (config.auth.customerLoginRequired && !session) {
        throw new HttpError(401, 'login_required', 'Please sign in or create an account to book a bay.');
      }
      if (session && !roles.can(session.role, 'booking:create')) throw new HttpError(403, 'forbidden', 'Your role cannot book a bay.');
      // The booking belongs to the signed-in customer. The browser cannot choose this value.
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : req.body;
      if (body && typeof body === 'object') body.customerId = session && session.role === 'customer' ? session.id : null;
      res.status(201).json(await bookings.startCheckout(body));
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

  // ---- The customer's pass: the entry and exit QR codes of a paid booking, and paying for extra parking time ----------
  // The pass token in the address is the key to the page (see gate.js), so nothing else is asked.
  const passLimit = createLimiter({ windowMs: 60 * 1000, max: 90 });
  const passToken = (req) => (typeof req.query.t === 'string' ? req.query.t : '');
  // The address that goes into a QR code: the settings if they name one, otherwise the address this page was opened on.
  const siteOrigin = (req) => config.gate.publicUrl || `${req.protocol}://${req.get('host')}`;

  app.get('/api/pass', passLimit, (req, res) => {
    res.json(gate.passInfo(passToken(req)));
  });

  app.get('/api/pass/qr', passLimit, (req, res) => {
    const svg = gate.qrFor(passToken(req), String(req.query.k || ''), siteOrigin(req));
    res.set('Cache-Control', 'no-store');
    res.type('image/svg+xml').send(svg);
  });

  app.post(
    '/api/pass/overstay/start',
    verifyLimit,
    wrap(async (req, res) => {
      res.json(await gate.startOverstay(req.body && req.body.t));
    })
  );

  app.post(
    '/api/pass/overstay/verify',
    verifyLimit,
    wrap(async (req, res) => {
      const { booking } = await gate.verifyOverstay(req.body);
      res.json({ status: 'paid', gate: gate.state(booking), booking: gate.summary(booking) });
    })
  );

  app.post(
    '/api/pass/overstay/demo-confirm',
    verifyLimit,
    wrap(async (req, res) => {
      const { booking } = await gate.confirmDemo(req.body && req.body.t);
      res.json({ status: 'paid', gate: gate.state(booking), booking: gate.summary(booking) });
    })
  );

  // More hours for a parked vehicle, before the booked end. The same three steps as paying for extra time: start, then verify
  // (or the pretend "Pay" button on a developer's computer). A late payment is settled by the webhook or the once-a-minute check.
  app.post(
    '/api/pass/extend/start',
    verifyLimit,
    wrap(async (req, res) => {
      res.json(await gate.startExtension(req.body && req.body.t, req.body && req.body.hours));
    })
  );

  const extensionReply = (result) => ({ status: result.outcome, booking: gate.summary(result.booking), gate: gate.state(result.booking), extend: gate.extendInfo(result.booking) });

  app.post(
    '/api/pass/extend/verify',
    verifyLimit,
    wrap(async (req, res) => {
      const result = await gate.verifyExtension(req.body);
      res.json(extensionReply(result));
    })
  );

  app.post(
    '/api/pass/extend/demo-confirm',
    verifyLimit,
    wrap(async (req, res) => {
      const result = await gate.confirmDemoExtension(req.body && req.body.t);
      res.json(extensionReply(result));
    })
  );

  // ---- Accounts: customers sign up and sign in; the operator signs in with the operator password -------------------
  const signInLimit = createLimiter({ windowMs: 60 * 1000, max: 20, message: 'Too many sign-in attempts. Please wait a minute and try again.' });
  const signUpLimit = createLimiter({ windowMs: 60 * 60 * 1000, max: 15, message: 'Too many accounts were created from this connection. Please try again later.' });

  app.get('/api/me', (req, res) => {
    res.json({ user: auth.publicUser(auth.current(req)) });
  });

  app.post(
    '/api/auth/signup',
    ownPagesOnly,
    signUpLimit,
    wrap(async (req, res) => {
      const session = await auth.signup(req.body, req, res);
      res.status(201).json({ user: auth.publicUser(session), next: '/account' });
    })
  );

  app.post(
    '/api/auth/login',
    ownPagesOnly,
    signInLimit,
    wrap(async (req, res) => {
      const session = await auth.login(req.body, req, res);
      res.json({ user: auth.publicUser(session), next: session.role === 'attendant' ? '/scan' : STAFF_ROLES.has(session.role) ? '/dashboard' : '/account' });
    })
  );

  // A customer who forgot the password asks for a link by email. The answer is the same for every address, so nobody can use this
  // to find out which emails have accounts. The link carries the site's own address (PUBLIC_URL, or the address of a local
  // computer), never one taken from the request, so a forged Host header cannot send the link to another site.
  const forgotLimit = createLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many requests from this connection. Please try again in a few minutes.' });
  const resetLimit = createLimiter({ windowMs: 15 * 60 * 1000, max: 15, message: 'Too many attempts from this connection. Please try again in a few minutes.' });
  const resetOrigin = (req) => config.gate.publicUrl || (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(req.hostname) ? `${req.protocol}://${req.get('host')}` : '');

  app.post(
    '/api/auth/forgot',
    ownPagesOnly,
    forgotLimit,
    wrap(async (req, res) => {
      if (!mailer.enabled) throw new HttpError(503, 'email_not_set_up', `A new password cannot be sent by email on this site yet. ${config.supportEmail ? 'Please write to ' + config.supportEmail + '.' : 'Please contact the parking owner.'}`);
      const origin = resetOrigin(req);
      if (!origin) throw new HttpError(503, 'site_address_unknown', 'A new password cannot be sent by email until the site address is set (PUBLIC_URL). Please contact the parking owner.');
      const raw = req.body && req.body.email;
      if (!normalizeEmail(raw)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
      const found = auth.startReset(raw);
      if (found) {
        // sent in the background, so the answer takes the same time whether or not the address has an account
        const link = `${origin}/reset-password?t=${encodeURIComponent(found.token)}`;
        mailer
          .send({ to: found.user.email, ...passwordResetEmail({ siteName: config.siteName, supportEmail: config.supportEmail, name: found.user.name, link, minutes: found.minutes }) })
          .then((sent) => sent.status !== 'sent' && log.warn(`A password reset email could not be sent (${sent.reason || sent.status}).`))
          .catch((err) => log.warn(`A password reset email could not be sent: ${err.message}`));
      }
      res.json({ ok: true, minutes: config.auth.resetMinutes, message: `If there is a customer account for that email, a link to choose a new password is on its way. It works for ${config.auth.resetMinutes} minutes and only once.` });
    })
  );

  app.post(
    '/api/auth/reset',
    ownPagesOnly,
    resetLimit,
    wrap(async (req, res) => {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const session = await auth.resetPassword(String(b.t || ''), b.password, req, res);
      res.json({ user: auth.publicUser(session), next: '/account' });
    })
  );

  app.post('/api/auth/logout', ownPagesOnly, (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });

  // A signed-in customer's own bookings (and nobody else's).
  app.get('/api/account/bookings', (req, res) => {
    const session = auth.current(req);
    if (!session) throw new HttpError(401, 'login_required', 'Please sign in to see your bookings.');
    if (session.role !== 'customer' || !roles.can(session.role, 'booking:view-own')) throw new HttpError(403, 'forbidden', 'Only customer accounts have bookings of their own. The owner and government officials see every booking under Bookings.');
    res.json({ bookings: bookings.forCustomer(session.id) });
  });

  // A signed-in customer cancels their own booking before it starts. The refund follows the cancellation rule; `acceptRefund` is
  // the amount (in rupees) the page showed, so a customer is never surprised by a lower refund than the one they agreed to.
  const accountActionLimit = createLimiter({ windowMs: 60 * 1000, max: 20 });
  app.post(
    '/api/account/bookings/:ref/cancel',
    ownPagesOnly,
    accountActionLimit,
    wrap(async (req, res) => {
      const session = auth.current(req);
      if (!session) throw new HttpError(401, 'login_required', 'Please sign in to cancel a booking.');
      if (session.role !== 'customer' || !roles.can(session.role, 'booking:cancel-own')) throw new HttpError(403, 'forbidden', 'Only the customer who made a booking can cancel it here. The owner cancels bookings from the dashboard.');
      const ref = String(req.params.ref).toUpperCase();
      if (!/^[A-Z0-9]{6,12}$/.test(ref)) throw new HttpError(400, 'invalid_ref', 'That booking reference is not valid.');
      const accepted = req.body && req.body.acceptRefund !== undefined && req.body.acceptRefund !== null && req.body.acceptRefund !== '' ? Number(req.body.acceptRefund) : NaN;
      if (!Number.isFinite(accepted) || accepted < 0) throw new HttpError(400, 'invalid_refund', 'Confirm the refund amount that was shown to you.');
      const { outcome, booking, quote, message } = await bookings.customerCancel(session.id, ref, Math.round(accepted * 100));
      const email = await emailCustomerCancelled(session, booking, quote, outcome);
      res.json({ ok: true, outcome, message: `${message}${email.note ? ' ' + email.note : ''}`, email: email.status, refundAmount: quote.refundPaise / 100, refundPercent: quote.percent });
    })
  );

  // ---- Operator area: protected by a user name and password ---------------------------------------
  const wrongPasswords = new HitCounter(60 * 1000, now);
  // Only staff get through: the ADMIN (signed in at /login with the operator user name and password, or a script that sends
  // the operator password with HTTP Basic) and government OFFICIALS (signed in at /login with their own email). A signed-in
  // customer is refused with 403.
  const operatorOnlyPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff only</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5"><h1>Staff only</h1><p>You are signed in as a customer, and this page is only for the parking owner and staff.</p><p><a href="/account">My bookings</a> &middot; <a href="/">Back to ${escapeHtml(config.siteName)}</a></p>`;
  function operatorGate(req, res, next) {
    const { user, password } = config.operator;
    res.set('Cache-Control', 'no-store');
    const session = auth.current(req);
    const pass = (role = 'admin') => {
      req.actor = { role };
      return next();
    };
    if (session && STAFF_ROLES.has(session.role)) return pass(session.role);
    if (!password) {
      if (config.production) {
        return res.status(503).type('text/plain').send('The operator dashboard is switched off until OPERATOR_PASSWORD is set in the server settings.');
      }
      return pass(); // on your own computer the dashboard is open, so it is easy to try
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
        if (colon !== -1 && sameSecret(decoded.slice(0, colon), user) && sameSecret(decoded.slice(colon + 1), password)) return pass();
      }
      wrongPasswords.hit(who);
    }
    const accept = String(req.get('Accept') || '');
    const wantsHtml = /\btext\/html\b/i.test(accept);
    const wantsJson = !wantsHtml && /\bapplication\/json\b/i.test(accept);
    if (session) {
      if (wantsHtml) return res.status(403).type('html').send(operatorOnlyPage);
      return res.status(403).json({ error: 'forbidden', message: 'This area is only for the parking owner and staff. You are signed in as a customer.' });
    }
    // A browser opening a page is sent to the sign-in page; the pages' own requests get a plain "sign in" answer (no
    // browser password box); scripts such as curl get the classic HTTP Basic challenge.
    if (!header && wantsHtml && req.method === 'GET') return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    if (!header && wantsJson) return res.status(401).json({ error: 'login_required', message: 'Please sign in as the operator.' });
    res.set('WWW-Authenticate', 'Basic realm="Parking operator", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Sign in with the operator user name and password.');
  }

  // Role-based access control: operatorGate proves WHO is asking (and only lets staff through); needs() then checks that
  // the role really holds the permission the route needs (see src/roles.js). A role that lacks it gets 403 and is told so.
  const needs = (permission) => (req, res, next) => {
    if (req.actor && roles.can(req.actor.role, permission)) return next();
    return res.status(403).json({ error: 'forbidden', message: 'Your role does not have permission for this: ' + (roles.PERMISSIONS[permission] || permission) + '.' });
  };
  // A staff page the signed-in role may not open: an official who types the owner's address, or a gate attendant who types the
  // dashboard's, is told so (the page would load no data anyway). Each is sent to the page that is theirs.
  const ownerOnlyPage = (permission) => (req, res, next) => {
    if (req.actor && roles.can(req.actor.role, permission)) return next();
    const gateOnly = req.actor && req.actor.role === 'attendant';
    const title = gateOnly ? 'Not for your role' : 'Owner only';
    const text = gateOnly ? 'This page is not open to gate staff. You can scan customers in and out.' : 'This page is only for the parking owner.';
    const home = gateOnly ? '<a href="/scan">Scan QR</a>' : '<a href="/dashboard">Dashboard</a>';
    return res.status(403).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5"><h1>${title}</h1><p>${text}</p><p>${home} &middot; <a href="/">Back to ${escapeHtml(config.siteName)}</a></p>`);
  };
  const userById = (id) => auth.users.byId(id);
  // The customer numbers and lists count customers only: an official's or an admin's login is not a customer.
  const customerAccounts = () => auth.users.users.filter((u) => !STAFF_ROLES.has(u.role));

  app.get('/api/dashboard', operatorGate, needs('bookings:view-all'), (req, res) => {
    res.json({ ...bookings.dashboard(), payments: bookings.paymentStatus(), operatorProtected: Boolean(config.operator.password) });
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
      return res.status(403).json({ error: 'forbidden', message: 'That request did not come from a page of this website.' });
    }
    return next();
  }

  const operatorLimit = createLimiter({ windowMs: 60 * 1000, max: 60 });

  // Scanning customers in and out at the lot. Only the admin (gate:scan). The phone must be signed in as the admin.
  const gateLimit = createLimiter({ windowMs: 60 * 1000, max: 240 });
  const scanner = (req) => auth.current(req);

  app.post(
    '/api/dashboard/gate/scan',
    operatorGate,
    needs('gate:scan'),
    ownPagesOnly,
    gateLimit,
    wrap(async (req, res) => {
      res.json(await gate.scan(req.body, scanner(req)));
    })
  );

  app.get('/api/dashboard/gate/status', operatorGate, needs('gate:scan'), gateLimit, (req, res) => {
    res.json(gate.status(req.query.ref));
  });

  app.get('/api/dashboard/gate/inside', operatorGate, needs('gate:scan'), gateLimit, (req, res) => {
    res.json(gate.inside());
  });

  // The customer paid the extra time in cash, or the admin drops the charge.
  app.post(
    '/api/dashboard/gate/settle',
    operatorGate,
    needs('gate:scan'),
    ownPagesOnly,
    gateLimit,
    wrap(async (req, res) => {
      // Waiving a charge gives the owner's money away: gate staff may only mark it as collected another way (cash).
      if (req.body && req.body.method === 'waive' && !roles.can(req.actor.role, 'gate:waive')) {
        throw new HttpError(403, 'forbidden', 'Your role does not have permission for this: ' + roles.PERMISSIONS['gate:waive'] + '. Ask the owner.');
      }
      res.json(await gate.settleManually(req.body && req.body.ref, req.body && req.body.method, scanner(req)));
    })
  );

  // Find the bookings of one vehicle number that the operator can cancel or retry a refund for.
  app.get('/api/dashboard/bookings', operatorGate, needs('bookings:view-all'), operatorLimit, (req, res) => {
    res.json(bookings.operatorFind(req.query.plate));
  });

  // The "Setup check" on the dashboard. It only reports on the request that asked: nothing secret, nothing about anyone else.
  app.get('/api/dashboard/connection', operatorGate, needs('system:view'), operatorLimit, (req, res) => {
    res.json(connectionReport(req, config, store, chat));
  });

  // Numbers for the analytics page: collection per day, the busiest hours and so on.
  app.get('/api/dashboard/analytics', operatorGate, needs('analytics:view'), operatorLimit, (req, res) => {
    res.json(bookings.analytics(req.query));
  });

  // The demand forecast and the price suggestions. Read-only: nothing here can change a price.
  app.get('/api/dashboard/forecast', operatorGate, needs('analytics:view'), operatorLimit, (req, res) => {
    res.json(bookings.forecast());
  });

  // Sample bookings so the analytics can be shown before any real customer has booked. Test mode only (see addSampleData).
  app.post('/api/dashboard/sample-data', operatorGate, needs('samples:manage'), ownPagesOnly, operatorLimit, (req, res) => {
    const action = req.body && req.body.action;
    if (action === 'add') return res.json({ ok: true, ...bookings.addSampleData() });
    if (action === 'remove') return res.json({ ok: true, ...bookings.removeSampleData() });
    throw new HttpError(400, 'invalid_action', 'The action must be add or remove.');
  });

  // The owner's numbers: money (today, this week, this month, all time), how full the lot is, customers, weekdays, months.
  app.get('/api/dashboard/overview', operatorGate, needs('analytics:view'), operatorLimit, (req, res) => {
    res.json(bookings.ownerOverview(customerAccounts()));
  });

  // Every booking, with filters, search and pages; and the same list as a spreadsheet file.
  app.get('/api/dashboard/all-bookings', operatorGate, needs('bookings:view-all'), operatorLimit, (req, res) => {
    res.json(bookings.allBookings(req.query, userById));
  });

  app.get('/api/dashboard/export.csv', operatorGate, needs('bookings:export'), operatorLimit, (req, res) => {
    const day = S.lotDateString(now(), config.utcOffsetMinutes);
    res.set('Content-Disposition', `attachment; filename="bookings-${day}.csv"`);
    // the first character lets Excel read names with accents or other scripts correctly
    res.type('text/csv; charset=utf-8').send('\ufeff' + bookings.bookingsCsv(req.query, userById));
  });

  // Every customer account: name, e-mail, what they booked and spent. Never a password.
  app.get('/api/dashboard/customers', operatorGate, needs('customers:view'), operatorLimit, (req, res) => {
    res.json(bookings.customerList(customerAccounts(), req.query));
  });

  // Who may do what: the roles and their permissions.
  app.get('/api/dashboard/roles', operatorGate, needs('bookings:view-all'), operatorLimit, (req, res) => {
    res.json(roles.matrix());
  });

  // The logins of government officials. Only the owner (accounts:manage) may see, create, change or remove them.
  app.get('/api/dashboard/officials', operatorGate, needs('accounts:manage'), operatorLimit, (req, res) => {
    res.json({ officials: auth.officials() });
  });

  app.post(
    '/api/dashboard/officials',
    operatorGate,
    needs('accounts:manage'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      res.status(201).json({ official: await auth.addOfficial(req.body) });
    })
  );

  app.post(
    '/api/dashboard/officials/:id/password',
    operatorGate,
    needs('accounts:manage'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      res.json({ official: await auth.setOfficialPassword(req.params.id, req.body) });
    })
  );

  app.post(
    '/api/dashboard/officials/:id/remove',
    operatorGate,
    needs('accounts:manage'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      res.json({ ok: true, official: await auth.removeOfficial(req.params.id) });
    })
  );

  // The logins of gate attendants (the gate staff who scan customers in and out). Only the owner may see, create, change or
  // remove them.
  app.get('/api/dashboard/attendants', operatorGate, needs('accounts:manage'), operatorLimit, (req, res) => {
    res.json({ attendants: auth.attendants() });
  });

  app.post(
    '/api/dashboard/attendants',
    operatorGate,
    needs('accounts:manage'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      res.status(201).json({ attendant: await auth.addAttendant(req.body) });
    })
  );

  app.post(
    '/api/dashboard/attendants/:id/password',
    operatorGate,
    needs('accounts:manage'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      res.json({ attendant: await auth.setAttendantPassword(req.params.id, req.body) });
    })
  );

  app.post(
    '/api/dashboard/attendants/:id/remove',
    operatorGate,
    needs('accounts:manage'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      res.json({ ok: true, attendant: await auth.removeAttendant(req.params.id) });
    })
  );

  // Tell the customer by email that the admin cancelled the booking. Never fails the cancellation: the answer says in words
  // what happened, and the admin sees it in the message under the booking.
  async function emailCustomer(booking, row, outcome) {
    if (outcome !== 'refunded' && outcome !== 'refund_failed') return { status: 'skipped', note: '' };
    const user = booking.customerId ? userById(booking.customerId) : null;
    if (!user || !user.email) return { status: 'no_email', note: 'No email was sent: this booking was made without an account, so there is no customer email.' };
    if (!mailer.enabled) return { status: 'not_set_up', note: 'No email was sent: email is not set up on this site (add EMAIL_API_KEY and EMAIL_FROM in Render).' };
    const money = (paise) => '₹' + (paise % 100 ? (paise / 100).toFixed(2) : String(paise / 100));
    const content = cancellationEmail({
      siteName: config.siteName,
      supportEmail: config.supportEmail,
      name: user.name,
      row,
      amountText: money(booking.amountPaise),
      refundId: booking.refundId || null,
      refunded: outcome === 'refunded',
    });
    const sent = await mailer.send({ to: user.email, ...content });
    if (sent.status === 'sent') return { status: 'sent', note: `An email about it was sent to ${maskEmail(user.email)}.` };
    return { status: 'failed', note: `The email to ${maskEmail(user.email)} could not be sent (${sent.reason}). Tell the customer yourself.` };
  }

  // Tell a customer by email that the booking they cancelled is cancelled, and what comes back. Never fails the cancellation.
  async function emailCustomerCancelled(user, booking, quote, outcome) {
    if (!user || !user.email) return { status: 'no_email', note: '' };
    if (!mailer.enabled) return { status: 'not_set_up', note: '' };
    const money = (paise) => '₹' + (paise % 100 ? (paise / 100).toFixed(2) : String(paise / 100));
    const refundText =
      outcome === 'refunded'
        ? `${money(quote.refundPaise)} (${quote.percent}% of what you paid) is being refunded to the payment method you used. It usually reaches you in 5 to 10 working days.${booking.refundId ? ` The refund number is ${booking.refundId}.` : ''}`
        : outcome === 'refund_failed'
          ? `The automatic refund of ${money(quote.refundPaise)} did not go through yet. The parking owner has been told and will send it again. You do not need to do anything.`
          : quote.refundPaise > 0
            ? 'The payment was only simulated, so nothing needs to be refunded.'
            : 'Under the cancellation rule nothing is refunded this close to the start.';
    const content = customerCancelEmail({ siteName: config.siteName, supportEmail: config.supportEmail, name: user.name, row: bookings.operatorRow(booking), amountText: money(booking.amountPaise), refundText });
    const sent = await mailer.send({ to: user.email, ...content });
    return sent.status === 'sent' ? { status: 'sent', note: `We also emailed it to ${maskEmail(user.email)}.` } : { status: 'failed', note: '' };
  }

  // Cancel a paid booking and refund it in full (or try a failed refund again).
  app.post(
    '/api/dashboard/bookings/:ref/cancel',
    operatorGate,
    needs('bookings:cancel-refund'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      const ref = String(req.params.ref).toUpperCase();
      if (!/^[A-Z0-9]{6,12}$/.test(ref)) throw new HttpError(400, 'invalid_ref', 'That booking reference is not valid.');
      const { outcome, booking, message } = await bookings.operatorCancel(ref);
      const row = bookings.operatorRow(booking);
      const email = await emailCustomer(booking, row, outcome);
      const said = `${message} ${email.note}`;
      if (outcome === 'refund_failed') return res.status(502).json({ error: 'refund_failed', message: said, email: email.status, booking: row });
      return res.json({ ok: true, outcome, message: said, email: email.status, booking: row });
    })
  );

  // Send a booking that has not arrived to another free bay, for example when a vehicle is still parked on its bay.
  app.post(
    '/api/dashboard/bookings/:ref/move-bay',
    operatorGate,
    needs('bookings:move-bay'),
    ownPagesOnly,
    operatorLimit,
    wrap(async (req, res) => {
      const ref = String(req.params.ref).toUpperCase();
      if (!/^[A-Z0-9]{6,12}$/.test(ref)) throw new HttpError(400, 'invalid_ref', 'That booking reference is not valid.');
      const who = scanner(req);
      const moved = await bookings.moveBay(ref, req.body && req.body.bay, gate.who(who));
      res.json({ ok: true, message: `Booking ${moved.booking.ref} now has bay ${moved.to} (it was ${moved.from}). The customer's pass shows the new bay.`, booking: bookings.operatorRow(moved.booking) });
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- What an ordinary phone camera shows ---------------------------------------------------------
  // The entry and exit QR codes hold the address /scan?t=... The admin's scanner page lives at /scan too, so a request that
  // carries a QR token is split here: the signed-in admin goes on to the scanner (which records the scan), and everyone
  // else, a customer or a passer-by with a normal camera, gets a plain page with the lot details only. No sign-in is asked.
  const spotLimit = createLimiter({ windowMs: 60 * 1000, max: 60 });
  const qrToken = (req) => (typeof req.query.t === 'string' ? req.query.t.trim() : '');
  const forStaffScanner = (req, res, next) => {
    const session = auth.current(req);
    if (!qrToken(req) || (session && roles.can(session.role, 'gate:scan'))) return next('route');
    return next();
  };
  app.get('/scan', forStaffScanner, spotLimit, (req, res) => {
    const t = qrToken(req);
    const spot = gate.spotFor(t);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!spot) {
      const body = '<section class="gate-banner bad" role="status"><h2>This QR code is not active</h2><p>It is not valid, or the booking was cancelled. Please ask the parking staff for help.</p></section>';
      return res.status(404).type('html').send(renderPage('spot.html', null, { SPOT_BODY: body, SPOT_STAFF_LINK: '' }));
    }
    const zoneLabel = /^level\b/i.test(spot.zone) ? 'Level' : 'Zone';
    const body =
      '<section class="pass-card" aria-label="Parking details">' +
      '<div class="stack g8"><p class="hold-line">Lot number</p><p class="bay-big">' + escapeHtml(spot.bay) + '</p></div>' +
      '<dl class="facts">' +
      '<div><dt>Parking</dt><dd>' + escapeHtml(spot.parking) + '</dd></div>' +
      '<div><dt>' + zoneLabel + '</dt><dd>' + escapeHtml(spot.zone) + '</dd></div>' +
      '</dl></section>';
    // The page itself carries nothing of the code (the booking reference is part of the token), so the staff link is plain.
    const staffLink = '<p class="fine">Parking staff? <a href="/login?next=%2Fscan">Sign in to scan</a>.</p>';
    return res.type('html').send(renderPage('spot.html', null, { SPOT_BODY: body, SPOT_STAFF_LINK: staffLink }));
  });

  // ---- The invoice of a finished booking (the pass link opens it) and the check that a printed copy is genuine ----------
  const invoiceLimit = createLimiter({ windowMs: 60 * 1000, max: 30 });
  const invoicePage = (res, status, body) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.status(status).type('html').send(renderPage('invoice.html', null, { INVOICE_BODY: body }));
  };
  const invoiceMessage = (tone, title, text) => `<section class="gate-banner ${tone}" role="status"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></section>`;
  app.get('/invoice', invoiceLimit, (req, res, next) => {
    (async () => {
      let booking;
      try {
        booking = gate.parse(qrToken(req), ['pass']).booking;
      } catch (err) {
        return invoicePage(res, 404, invoiceMessage('bad', 'No invoice', 'This link is not valid. Open your pass again and use the invoice link there.'));
      }
      try {
        const inv = await invoices.issue(booking);
        const check = `${siteOrigin(req)}/invoice/check?n=${encodeURIComponent(inv.no)}&c=${encodeURIComponent(inv.code)}`;
        return invoicePage(res, 200, invoices.html(inv, qrSvg(check, 'Invoice check'), check));
      } catch (err) {
        if (err instanceof HttpError) return invoicePage(res, err.status, invoiceMessage('warn', 'No invoice yet', err.message));
        throw err;
      }
    })().catch(next);
  });
  app.get('/invoice/check', invoiceLimit, (req, res) => {
    const inv = invoices.verify(typeof req.query.n === 'string' ? req.query.n.trim() : '', typeof req.query.c === 'string' ? req.query.c : '');
    if (!inv) return invoicePage(res, 404, invoiceMessage('bad', 'Not a match', 'This invoice number and code do not match what this website issued, or the amount was changed. Do not accept it as proof of payment.'));
    const text = `${inv.kind === 'tax' ? 'Tax invoice' : 'Receipt'} ${inv.no} dated ${inv.date}, issued by ${inv.seller.name} for vehicle ${inv.buyer.plate}: ₹${(inv.totalPaise / 100).toFixed(2)}.${inv.test ? ' This is a test copy: no real payment was made.' : ''}`;
    return invoicePage(res, 200, invoiceMessage(inv.test ? 'warn' : 'ok', 'This invoice is genuine', text));
  });

  // ---- Pages and files ---------------------------------------------------------------------------
  for (const [route, file] of Object.entries(PAGES)) {
    const gate = ADMIN_PAGES.has(route) ? [operatorGate] : [];
    if (PAGE_PERMISSION[route]) gate.push(ownerOnlyPage(PAGE_PERMISSION[route]));
    app.get(route, ...gate, (req, res) => {
      res.set('Cache-Control', route === '/reset-password' ? 'no-store' : 'no-cache');
      if (route === '/reset-password') res.set('Referrer-Policy', 'no-referrer'); // the link carries the secret
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
