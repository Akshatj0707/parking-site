'use strict';

// Starts server.js as its own program, the way "npm start" and the hosting service do, and stops it again.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { makeSite, bookAndPay, car } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Starts server.js and waits until it answers. The settings that matter are set to nothing, so a real .env file next
// to server.js cannot change the test (settings that are already set win over the file, even when empty).
async function start(t, dataDir, extraEnv = {}) {
  const port = await freePort();
  const blank = Object.fromEntries(
    ['NODE_ENV', 'HOST', 'TRUST_PROXY', 'RENDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'OPERATOR_USER', 'OPERATOR_PASSWORD', 'DISABLE_CSP',
      'ANTHROPIC_API_KEY', 'CHAT_ENABLED', 'CHAT_MODEL', 'CHAT_DAILY_LIMIT'].map((key) => [key, ''])
  );
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...blank, PORT: String(port), DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));

  const giveUpAt = Date.now() + 10 * 1000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch (err) {
      // not listening yet
    }
    if (Date.now() > giveUpAt) assert.fail(`the server did not start. Its output:\n${output}`);
    await sleep(50);
  }
  return { port, child, exited, output: () => output };
}

test('the server starts, answers, and stops cleanly when the hosting service says stop', async (t) => {
  const server = await start(t, tempDir(t));
  assert.match(server.output(), /is running/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/`)).status, 200);

  server.child.kill('SIGTERM');
  const result = await Promise.race([server.exited, sleep(5000).then(() => 'timeout')]);
  assert.notEqual(result, 'timeout', 'it should stop within a few seconds');
  assert.equal(result.code, 0);
});

test('the start-up message says where bookings are saved', async (t) => {
  const dir = tempDir(t);
  const server = await start(t, dir);
  assert.ok(server.output().includes(`Bookings    saved in ${dir}`), server.output());
  assert.doesNotMatch(server.output(), /Render disk/, 'no Render warning when the site is not on Render');
});

test('the start-up message says how the chat assistant will answer, and never prints the key', async (t) => {
  const key = 'sk-ant-not-a-real-key-for-this-test-0000';
  const plain = await start(t, tempDir(t));
  assert.match(plain.output(), /Chat\s+Instant answers, no AI\. Add ANTHROPIC_API_KEY to \.env/);
  assert.doesNotMatch(plain.output(), /does not look like an Anthropic key/);

  const ai = await start(t, tempDir(t), { ANTHROPIC_API_KEY: key, CHAT_MODEL: 'claude-sonnet-5-5', CHAT_DAILY_LIMIT: '50' });
  assert.match(ai.output(), /Chat\s+AI assistant \(claude-sonnet-5-5\): up to 50 AI answers a day, instant answers after that/);
  assert.ok(!ai.output().includes(key), 'the key is never printed');

  const capped = await start(t, tempDir(t), { ANTHROPIC_API_KEY: key, CHAT_DAILY_LIMIT: '0' });
  assert.match(capped.output(), /Chat\s+Instant answers: the AI is off because CHAT_DAILY_LIMIT is 0/);

  const off = await start(t, tempDir(t), { ANTHROPIC_API_KEY: key, CHAT_ENABLED: 'off' });
  assert.match(off.output(), /Chat\s+OFF: CHAT_ENABLED is off/);
  const asked = await fetch(`http://127.0.0.1:${off.port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(asked.status, 404, 'with the chat off, the route answers "not found"');

  const odd = await start(t, tempDir(t), { ANTHROPIC_API_KEY: 'my-secret-value' });
  assert.match(odd.output(), /does not look like an Anthropic key/);
  assert.ok(!odd.output().includes('my-secret-value'), 'even a wrong-looking key is never printed');
});

test('on Render, the start-up message warns when bookings are not on the Render disk', async (t) => {
  const dir = tempDir(t);
  const server = await start(t, dir, { RENDER: 'true' });
  assert.ok(server.output().includes(`Bookings    saved in ${dir}`), server.output());
  assert.match(server.output(), /WARNING\s+That folder is not on the Render disk \(\/var\/data\)/);
  assert.match(server.output(), /lost the next time the site restarts or is updated/);
  assert.match(server.output(), /Remove the DATA_DIR setting in Render/);
  assert.match(server.output(), /Exception: the free demo \(render-free\.yaml\) has no disk, so there this is expected: leave DATA_DIR as it is, and use Razorpay test keys only/, 'it says that the free demo is the one case where this is expected, and is for test keys only');
  assert.match(server.output(), /Chat\s+Instant answers, no AI\. Add ANTHROPIC_API_KEY under Environment in Render/, 'the chat hint names Render\'s Environment page, not a .env file');
  // The site still runs: the warning is advice, not a stop.
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
});

test('on start-up, a refund that the last shutdown cut off is marked, and the log says so', async (t) => {
  const dir = tempDir(t);
  // A bookings file as it is left when the server stops while a refund is being sent.
  const before = await makeSite({ razorpayKeys: true, existingDir: dir });
  const { paid } = await bookAndPay(before, car(), 'pay_test1');
  assert.equal(paid.status, 200, paid.text);
  Object.assign(before.store.bookings[0], { status: 'refund_pending', cancelReason: 'operator', cancelledAt: before.clock.t });
  before.store.save();
  await before.close();

  const server = await start(t, dir);
  assert.match(server.output(), /1 refund was cut off when the server last stopped/);
  const dash = await (await fetch(`http://127.0.0.1:${server.port}/api/dashboard`)).json();
  assert.equal(dash.attention.length, 1);
  assert.equal(dash.attention[0].status, 'refund_failed');
  assert.equal(dash.attention[0].refundInterrupted, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bookings.json'), 'utf8')).bookings[0].status, 'refund_failed');
});
