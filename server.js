'use strict';

const path = require('path');

// ---- 1. Check Node.js ---------------------------------------------------------------------------
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`This site needs Node.js 20.12 or newer, and this computer has ${process.version}.`);
  console.error('Install the current LTS version from https://nodejs.org and try again.');
  process.exit(1);
}

// ---- 2. Read the settings in the .env file (settings already set on the computer win) ----------
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error(`The .env file could not be read: ${err.message}`);
    process.exit(1);
  }
}

const { loadConfig, RENDER_DISK_PATH } = require('./src/config');
const { Store } = require('./src/store');
const { createRazorpayClient } = require('./src/payments');
const { createApp } = require('./src/app');

const config = loadConfig();
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), ...args),
  error: (...args) => console.error(stamp(), ...args),
};

const store = new Store(config.dataDir);
const razorpay = createRazorpayClient(config);
const app = createApp({ config, store, razorpay, log });
const bookings = app.locals.bookings;

// A refund that was being sent when the server last stopped may or may not have reached Razorpay. Mark it, so the
// dashboard lists it under "Needs attention" and the operator can retry it (Razorpay refuses a second full refund of
// the same payment, so a retry cannot send the money twice).
const interrupted = bookings.recoverInterruptedRefunds();
if (interrupted) {
  log.warn(`${interrupted} refund${interrupted === 1 ? ' was' : 's were'} cut off when the server last stopped. See "Needs attention" on the dashboard and press Retry refund.`);
}

// ---- 3. Start ----------------------------------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  const where = config.host === '127.0.0.1' || config.host === 'localhost' ? `http://localhost:${config.port}` : `port ${config.port}`;
  const mode = bookings.paymentMode;
  const lines = [''];
  lines.push(`  ${config.siteName} is running`);
  lines.push('  ' + '-'.repeat(60));
  lines.push(`  Website     ${where}`);
  if (config.operator.password) lines.push(`  Dashboard   ${where}/dashboard   (asks for the operator password)`);
  else if (config.production) lines.push('  Dashboard   switched off: set OPERATOR_PASSWORD to turn it on');
  else lines.push(`  Dashboard   ${where}/dashboard   (open to anyone who can reach this site: set OPERATOR_PASSWORD before putting it online)`);
  lines.push(`  Bookings    saved in ${config.dataDir}`);

  if (mode === 'razorpay') {
    lines.push(config.razorpay.live
      ? '  Payments    LIVE: real Razorpay payments, real money'
      : '  Payments    TEST MODE: Razorpay checkout with test keys, no real money moves');
  } else if (mode === 'demo') {
    lines.push('  Payments    DEMO MODE: no Razorpay keys found, so payment is simulated.');
    lines.push('              Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env to try the real checkout.');
  } else {
    lines.push('  Payments    OFF: production mode needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, so booking is disabled.');
  }
  if (!config.chat.enabled) {
    lines.push('  Chat        OFF: CHAT_ENABLED is off, so the chat window is hidden.');
  } else if (config.chat.ai) {
    lines.push(`  Chat        AI assistant (${config.chat.model}): up to ${config.chat.dailyLimit} AI answers a day, instant answers after that.`);
  } else if (config.chat.apiKey) {
    lines.push('  Chat        Instant answers: the AI is off because CHAT_DAILY_LIMIT is 0.');
  } else {
    lines.push(config.onRender
      ? '  Chat        Instant answers, no AI. Add ANTHROPIC_API_KEY under Environment in Render to let an AI answer as well (see DEPLOY-RENDER.md).'
      : '  Chat        Instant answers, no AI. Add ANTHROPIC_API_KEY to .env to let an AI answer as well (see README).');
  }
  if (config.chat.enabled && config.chat.apiKey && !/^sk-ant-/.test(config.chat.apiKey)) {
    lines.push('  Note        ANTHROPIC_API_KEY does not look like an Anthropic key (they start with sk-ant-). Check that it was copied in full.');
  }
  if (mode === 'razorpay' && !config.razorpay.webhookSecret) {
    lines.push('  Note        No RAZORPAY_WEBHOOK_SECRET set. Payments are still checked, but add the webhook before going live (see README).');
  }
  if (config.razorpay.live && !config.production) {
    lines.push('  Warning     Live keys are in use but NODE_ENV is not "production".');
  }
  if (config.production && config.trustProxy === false) {
    lines.push('  Note        Behind a hosting platform or proxy? Set TRUST_PROXY=1 so each visitor is counted separately.');
  }
  if (config.onRender && config.dataOnRenderDisk === false) {
    lines.push(`  WARNING     That folder is not on the Render disk (${RENDER_DISK_PATH}), so every booking is lost the next time the site restarts or is updated.`);
    lines.push(`              Remove the DATA_DIR setting in Render, or point it at a folder inside ${RENDER_DISK_PATH}.`);
  }
  lines.push('');
  console.log(lines.join('\n'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Close the other program, or choose another port by adding PORT=3001 to .env.`);
  } else {
    console.error('The server could not start:', err.message);
  }
  process.exit(1);
});

// ---- 4. Background jobs ------------------------------------------------------------------------------
// Tidy old unpaid holds once an hour, and once a minute look for payments whose confirmation never arrived.
setInterval(() => store.purge(Date.now()), 60 * 60 * 1000).unref();
setInterval(() => {
  bookings.reconcile().catch((err) => log.error('Checking for unconfirmed payments failed:', err.message));
}, 60 * 1000).unref();

// ---- 5. Stop cleanly (Ctrl+C, or "stop" from the hosting service). Bookings are saved after every change, so nothing
// is lost. Requests that are already running get up to 10 seconds to finish, so a refund that is being sent is not
// cut off by an update.
function shutdown() {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10 * 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
