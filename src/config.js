'use strict';

const path = require('path');

// On Render (render.com) a service keeps files only on its "disk", which is mounted at the folder named in render.yaml
// (mountPath). Everything else on Render is wiped at every restart and update. Keep the two in step.
const RENDER_DISK_PATH = '/var/data';

// Read a number from the environment, falling back to a default when it is blank or invalid.
function number(value, fallback, { min = 0 } = {}) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// True when `dir` is `root` itself or a folder somewhere inside it.
function isInside(dir, root) {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const keyId = String(env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(env.RAZORPAY_KEY_SECRET || '').trim();
  const live = keyId.startsWith('rzp_live_');

  // Render sets RENDER=true for every service it runs. There, two settings that are easy to get wrong choose themselves
  // when they are left empty (anything filled in always wins):
  //   - one proxy sits in front of the site, so TRUST_PROXY is 1;
  //   - bookings go in the disk's "test" folder while Razorpay test keys are in use and in its "live" folder once live
  //     keys are, so test bookings never mix with real ones and never block a real bay.
  const onRender = /^(1|true)$/i.test(String(env.RENDER || '').trim());
  const trustProxy = String(env.TRUST_PROXY || '').trim();
  const dataDir = path.resolve(env.DATA_DIR || (onRender ? `${RENDER_DISK_PATH}/${live ? 'live' : 'test'}` : path.join(__dirname, '..', 'data')));

  const weekendRaw = String(env.WEEKEND_DAYS === undefined || String(env.WEEKEND_DAYS).trim() === '' ? '0,6' : env.WEEKEND_DAYS);
  const parsedWeekend = [...new Set(weekendRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];

  const siteName = String(env.SITE_NAME || 'Bayfind').trim().slice(0, 40) || 'Bayfind';

  // The chat assistant. It is on by default and answers with simple built-in rules. Adding an Anthropic key makes it
  // answer with the Claude AI model instead (and fall back to the built-in answers whenever the AI cannot be reached).
  const chatEnabled = !/^(0|false|no|off)$/i.test(String(env.CHAT_ENABLED || '').trim());
  const chatKey = String(env.ANTHROPIC_API_KEY || '').trim();
  // A second way to get AI answers, with a FREE key: any service that speaks the OpenAI chat format. Presets were checked
  // against the providers' own documentation: Google Gemini (ai.google.dev/gemini-api/docs/openai) and Groq (console.groq.com/docs/openai).
  const AI_PRESETS = {
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', label: 'Google Gemini' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', label: 'Groq' },
    custom: { baseUrl: '', model: '', label: 'the AI service' },
  };
  const aiKey = String(env.AI_API_KEY || '').trim();
  const aiProviderName = String(env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const aiPreset = AI_PRESETS[aiProviderName] || AI_PRESETS.gemini;
  const aiBaseUrl = (String(env.AI_BASE_URL || '').trim() || aiPreset.baseUrl).replace(/\/+$/, '');
  const aiModel = String(env.AI_MODEL || '').trim() || aiPreset.model;
  // Anthropic wins when both keys are set.
  const provider = chatKey ? 'anthropic' : aiKey && /^https:\/\//.test(aiBaseUrl) && aiModel ? 'openai' : null;
  const chatDailyLimit = Math.floor(number(env.CHAT_DAILY_LIMIT, 500));

  const isOff = (value) => /^(0|false|no|off)$/i.test(String(value || '').trim());
  const isOn = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());
  // DEMO_PAYMENTS used to make a public site pretend to take payments. That switch is gone: a site in production only ever
  // takes real Razorpay payments (test keys give Razorpay's own test window, live keys take real money). The setting is
  // ignored, and the server says so once at start-up if it is still set.
  const demoSettingIgnored = isOn(env.DEMO_PAYMENTS);
  // On Render: is the bookings folder on the disk (true), or somewhere that is wiped at every restart (false)?
  // Nothing is known about other hosts, so there it is null.
  const dataOnRenderDisk = onRender ? isInside(dataDir, RENDER_DISK_PATH) : null;
  // Live keys on a host that forgets its files (Render's free size) would take real money and then lose the bookings.
  // Booking is switched off in that case, and the operator's dashboard says why.
  const unsafeLiveStorage = live && onRender && dataOnRenderDisk === false;

  return {
    production,
    port: number(env.PORT, 3000),
    // Local runs listen on this computer only. Hosting platforms need 0.0.0.0, which is the default in production.
    host: env.HOST || (production || onRender ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: trustProxy ? (/^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy) : onRender ? 1 : false,
    dataDir,
    onRender,
    dataOnRenderDisk,
    unsafeLiveStorage,
    demoSettingIgnored,
    // Escape hatch: if a browser's security rules ever block the Razorpay popup, set DISABLE_CSP=1 and restart.
    disableCsp: /^(1|true|yes)$/i.test(String(env.DISABLE_CSP || '').trim()),

    siteName,
    supportEmail: String(env.SUPPORT_EMAIL || '').trim(),
    // Shown on the Contact page and in the policy pages. Razorpay wants them on a live site.
    businessName: String(env.BUSINESS_NAME || '').trim().slice(0, 80) || siteName,
    businessAddress: String(env.BUSINESS_ADDRESS || '').trim().slice(0, 240),
    supportPhone: String(env.SUPPORT_PHONE || '').trim().slice(0, 30),

    razorpay: {
      keyId,
      keySecret,
      webhookSecret: String(env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
      configured: Boolean(keyId && keySecret),
      live,
    },
    operator: {
      user: String(env.OPERATOR_USER || 'operator'),
      password: String(env.OPERATOR_PASSWORD || ''),
    },
    // Accounts and roles. ADMIN is the operator (OPERATOR_USER and OPERATOR_PASSWORD); CUSTOMER is anyone who signs up.
    auth: {
      // On by default: a customer signs in (or signs up) before booking. CUSTOMER_LOGIN_REQUIRED=off lets anyone book.
      customerLoginRequired: !isOff(env.CUSTOMER_LOGIN_REQUIRED),
      // Signs the sign-in cookies. Optional: when empty, a random key is kept next to the bookings.
      sessionSecret: String(env.SESSION_SECRET || '').trim(),
      // For trying the site on your own computer: SEED_TEST_CUSTOMER=on creates a customer with a published password. It is
      // never created when Razorpay keys are set (a real site), and it is off unless asked for.
      seedTestCustomer: !(keyId && keySecret) && isOn(env.SEED_TEST_CUSTOMER),
    },
    chat: {
      enabled: chatEnabled,
      apiKey: chatKey,
      model: provider === 'openai' ? aiModel : String(env.CHAT_MODEL || '').trim() || 'claude-haiku-5-5',
      // The most AI answers in one day for the whole site, counted on the lot's clock. Past it the chat goes on with the
      // built-in answers until the next day. 0 turns the AI off even when a key is set.
      dailyLimit: chatDailyLimit,
      // True when visitors' questions can be sent to the AI.
      ai: chatEnabled && Boolean(provider) && chatDailyLimit > 0,
      // Who answers: 'anthropic', 'openai' (any OpenAI-compatible service, see AI_PROVIDER) or null (built-in answers only).
      provider,
      providerLabel: provider === 'anthropic' ? 'Anthropic Claude' : provider === 'openai' ? aiPreset.label : null,
      openai: { apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel },
    },

    // Rupees per hour. Change them here or with the RATE_* lines in .env.
    rates: {
      car: { weekday: number(env.RATE_CAR_WEEKDAY, 40), weekend: number(env.RATE_CAR_WEEKEND, 60) },
      bike: { weekday: number(env.RATE_BIKE_WEEKDAY, 20), weekend: number(env.RATE_BIKE_WEEKEND, 30) },
    },
    weekendDays: parsedWeekend.length ? parsedWeekend : [0, 6], // 0 = Sunday ... 6 = Saturday
    utcOffsetMinutes: number(env.UTC_OFFSET_MINUTES, 330, { min: -720 }), // India Standard Time

    hoursOptions: [1, 2, 3, 4],
    slotMinutes: 30,
    startGraceMinutes: 15,
    maxAdvanceDays: 7,
    holdMinutes: number(env.HOLD_MINUTES, 10, { min: 1 }),
  };
}

module.exports = { loadConfig, RENDER_DISK_PATH };
