'use strict';

// The README is what the owner works from, so it must not fall behind the code. These checks catch the two ways it did before:
// a setting added without a line in the README, and a sentence that says a feature does not exist after it was built.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');

// Settings the README deliberately leaves out: DEMO_PAYMENTS was removed (config only notices it, and says so), RENDER is set by
// the host itself, and the optional AI answers for the chat (the keys, the model and the daily limit) are left out of the README
// on purpose: the site works without them and the chat then answers from the site's own built-in answers.
const NOT_DOCUMENTED = new Set(['DEMO_PAYMENTS', 'RENDER', 'AI_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'ANTHROPIC_API_KEY', 'CHAT_MODEL', 'CHAT_DAILY_LIMIT']);

test('every setting that src/config.js reads has its own entry in the README', () => {
  const names = [...new Set([...config.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].filter((n) => !NOT_DOCUMENTED.has(n));
  assert.ok(names.length > 40, `found ${names.length} settings`);
  const missing = names.filter((n) => !readme.includes('`' + n + '`'));
  assert.deepEqual(missing, [], `add these to the settings table in section 4: ${missing.join(', ')}`);
});

test('the README no longer says that customers cannot sign in, cancel or add time', () => {
  for (const stale of ['No driver accounts', 'Drivers cannot cancel', 'there are no accounts', 'There is no change or extend button', 'No emails or text messages']) {
    assert.ok(!readme.includes(stale), `"${stale}" is out of date`);
  }
});

test('the README does not mention the AI services or the names of their models', () => {
  assert.doesNotMatch(readme, /claude|anthropic|\bAI\b|gemini|groq|openai|haiku|sonnet/i);
});

test('the README explains what a customer can do alone and which emails go out', () => {
  for (const heading of ['### What a signed-in customer can do by themselves', '### Emails the site sends', '### Empty bays and blocked bays']) {
    assert.ok(readme.includes(heading), heading);
  }
  // the refund rule in the README names the same three settings the code reads
  for (const name of ['CANCEL_FREE_HOURS', 'CANCEL_GRACE_MINUTES', 'CANCEL_LATE_REFUND_PERCENT', 'EXTEND_MAX_HOURS', 'EXTEND_MAX_TOTAL_HOURS', 'NO_SHOW_RELEASE_MINUTES', 'BAY_WARNING_MINUTES', 'RESET_LINK_MINUTES', 'END_REMINDER_MINUTES']) {
    assert.ok(readme.split('`' + name + '`').length > 2, `${name} is explained in the text as well as in the table`);
  }
});

test('the README lists every email the site can send, and says how many there are', () => {
  const mail = require('../src/mail');
  const kinds = Object.keys(mail).filter((k) => /Email$/.test(k) && k !== 'maskEmail'); // maskEmail only hides part of an address
  assert.equal(kinds.length, 5, `the code has these emails: ${kinds.join(', ')}`);
  assert.ok(readme.includes('Only these five, and only when'), 'section 3 says "five"');
  assert.ok(readme.includes('The five emails the site can send'), 'the limitations list says "five"');
  const section = readme.split('### Emails the site sends')[1].split('### ')[0];
  assert.equal((section.match(/^- \*\*/gm) || []).length, 5, 'one bullet for each email');
  assert.ok(section.includes('Your password was changed'), 'the password-changed email is listed');
});

test('the defaults the README quotes are the defaults in the code', () => {
  const cfgDefault = (name) => {
    const m = config.match(new RegExp('env\\.' + name + ',\\s*(\\d+)'));
    return m ? Number(m[1]) : null;
  };
  const expect = { CANCEL_FREE_HOURS: 2, CANCEL_GRACE_MINUTES: 10, CANCEL_LATE_REFUND_PERCENT: 50, EXTEND_MAX_HOURS: 4, EXTEND_MAX_TOTAL_HOURS: 8, NO_SHOW_RELEASE_MINUTES: 30, BAY_WARNING_MINUTES: 30, RESET_LINK_MINUTES: 30, END_REMINDER_MINUTES: 15 };
  for (const [name, value] of Object.entries(expect)) {
    assert.equal(cfgDefault(name), value, `${name} default in src/config.js`);
    const row = readme.split('\n').find((l) => l.startsWith('| `' + name + '`'));
    assert.ok(row && row.trim().endsWith('| `' + value + '` |'), `${name} row in the settings table shows ${value}`);
  }
});
