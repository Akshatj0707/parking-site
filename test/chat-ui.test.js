'use strict';

// The chat window in the browser: the plain functions in public/js/chat.js (loaded here in Node), the rules its code and
// style sheet must follow, and the pages that carry it. How it looks and behaves in a real browser is checked by hand
// with screenshots, not here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../public/js/chat.js');
const { makeSite, AI_KEY } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (...parts) => fs.readFileSync(path.join(PUBLIC, ...parts), 'utf8');

// ===== Showing an answer ====================================================================================

test('bold words are bold, and a ** with no partner is just text', () => {
  assert.deepEqual(ui.inline('Total is **₹80**.'), [{ text: 'Total is ', bold: false }, { text: '₹80', bold: true }, { text: '.', bold: false }]);
  assert.deepEqual(ui.inline('**only bold**'), [{ text: 'only bold', bold: true }]);
  assert.deepEqual(ui.inline('a **b'), [{ text: 'a **b', bold: false }]);
  assert.deepEqual(ui.inline('**a** and **b** and **c'), [
    { text: 'a', bold: true },
    { text: ' and ', bold: false },
    { text: 'b', bold: true },
    { text: ' and **c', bold: false },
  ]);
  assert.deepEqual(ui.inline(''), []);
});

test('a link in an answer keeps its words and loses its address, so nothing can lead away from the site', () => {
  assert.deepEqual(ui.inline('See [the prices](https://evil.example/pay) now'), [{ text: 'See the prices now', bold: false }]);
  assert.deepEqual(ui.inline('Use `code` here'), [{ text: 'Use code here', bold: false }]);
});

test('an answer becomes paragraphs, bullet lists and numbered lists', () => {
  const blocks = ui.parseRich('Parking is charged by the hour.\n\n- Car: **₹40** an hour\n- Two-wheeler: ₹20 an hour\n\n1. Choose a bay\n2. Pay online\n\nDone.');
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'ul', 'ol', 'p']);
  assert.deepEqual(blocks[1].items, [
    [{ text: 'Car: ', bold: false }, { text: '₹40', bold: true }, { text: ' an hour', bold: false }],
    [{ text: 'Two-wheeler: ₹20 an hour', bold: false }],
  ]);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[2].start, 1);
  assert.deepEqual(blocks[3].runs, [{ text: 'Done.', bold: false }]);
});

test('lines of one paragraph stay on their own lines, and other kinds of list and heading are tidied', () => {
  assert.deepEqual(ui.parseRich('line one\nline two')[0].runs, [{ text: 'line one\nline two', bold: false }]);
  assert.deepEqual(ui.parseRich('line one\r\nline two')[0].runs, [{ text: 'line one\nline two', bold: false }]);
  assert.deepEqual(ui.parseRich('* a\n• b\n- c')[0].items.length, 3);
  assert.deepEqual(ui.parseRich('3) three\n4) four')[0], { type: 'ol', start: 3, items: [[{ text: 'three', bold: false }], [{ text: 'four', bold: false }]] });
  assert.deepEqual(ui.parseRich('## Prices\nCar ₹40'), [
    { type: 'p', runs: [{ text: 'Prices', bold: true }] },
    { type: 'p', runs: [{ text: 'Car ₹40', bold: false }] },
  ]);
  assert.deepEqual(ui.parseRich('above\n---\nbelow').map((b) => b.type), ['p', 'p']);
  assert.deepEqual(ui.parseRich('- a\nnot in the list').map((b) => b.type), ['ul', 'p']);
  assert.deepEqual(ui.parseRich(''), []);
  assert.deepEqual(ui.parseRich('   \n\n  '), []);
});

test('markup in an answer stays as the letters it was typed with', () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> &amp; "quotes"';
  const [block] = ui.parseRich(evil);
  assert.equal(block.type, 'p');
  assert.equal(block.runs.map((r) => r.text).join(''), evil, 'nothing is removed or changed: it is shown as text, never read as HTML');
});

// ===== Buttons and cards ====================================================================================

test('a button may lead only to a page of this site, a phone number or an email address', () => {
  for (const good of ['/pricing', '/book?vehicle=car', '/book?vehicle=bike&plate=MP09AB1234', '/lookup?plate=MP09AB1234', '/#pricing', 'tel:+919876543210', 'tel:08012345678', 'mailto:help@bayfind.example']) {
    assert.equal(ui.safeHref(good), good, good);
  }
  for (const bad of [
    '//evil.example', '/\\evil.example', 'https://evil.example', 'http://evil.example', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x',
    'tel:abc', 'tel:12', 'tel:+91 98765 43210', 'mailto:nobody', 'mailto:a b@c.d', 'mailto:<x>@y.z', '/ pricing', '/pricing"onclick="x', '/pricing<b>', 'pricing', '', '/' + 'a'.repeat(400),
    null, undefined, 42, {}, ['/pricing'],
  ]) {
    assert.equal(ui.safeHref(bad), null, String(bad));
  }
});

test('a button needs a label and a safe address', () => {
  assert.deepEqual(ui.safeAction({ label: ' See pricing ', href: '/pricing' }), { label: 'See pricing', href: '/pricing' });
  for (const bad of [null, {}, { label: '', href: '/pricing' }, { label: 'x', href: 'https://evil.example' }, { label: 'x'.repeat(81), href: '/pricing' }, { label: 5, href: '/pricing' }, { href: '/pricing' }]) {
    assert.equal(ui.safeAction(bad), null);
  }
});

const CARD = { kind: 'bays', vehicle: 'car', label: '4-wheeler', window: 'Wed 14 Oct, 11:00 am – 1:00 pm', hours: 2, free: 199, total: 200, zones: [{ name: 'Level 1', free: 49 }, { name: 'Level 2', free: 50 }] };

test('the free-bays card is drawn only from exactly what the server sends', () => {
  assert.deepEqual(ui.safeCard(CARD), CARD);
  assert.deepEqual(ui.safeCard({ ...CARD, extra: '<b>x</b>', zones: [{ name: 'Level 1', free: 49, evil: 1 }] }).zones, [{ name: 'Level 1', free: 49 }], 'unknown fields are dropped');
  assert.deepEqual(ui.safeCard({ ...CARD, zones: undefined }).zones, []);
  assert.equal(ui.safeCard({ ...CARD, zones: Array.from({ length: 30 }, (_, i) => ({ name: 'Z' + i, free: 1 })) }).zones.length, 12);
  assert.deepEqual(ui.safeCard({ ...CARD, zones: [{ name: 'ok', free: 1 }, { name: '', free: 1 }, { name: 'x', free: -1 }, { name: 'x', free: 1.5 }, null] }).zones, [{ name: 'ok', free: 1 }]);
  for (const bad of [
    null, 'card', {}, { ...CARD, kind: 'other' }, { ...CARD, vehicle: 'truck' }, { ...CARD, label: '' }, { ...CARD, window: 'x'.repeat(81) }, { ...CARD, hours: -1 }, { ...CARD, hours: 'two' },
    { ...CARD, free: 201 }, { ...CARD, free: -1 }, { ...CARD, free: 1.5 }, { ...CARD, total: 'many' },
  ]) {
    assert.equal(ui.safeCard(bad), null, JSON.stringify(bad));
  }
});

// ===== What is sent and what is kept ========================================================================

test('the server is sent the latest messages as text, with the roles the server knows', () => {
  const messages = [];
  for (let i = 0; i < 15; i++) messages.push({ role: 'user', text: 'q' + i }, { role: 'bot', text: 'a' + i, actions: [{ label: 'x', href: '/pricing' }], cards: [CARD] });
  const sent = ui.historyFor(messages);
  assert.equal(sent.length, 20);
  assert.deepEqual(sent[19], { role: 'assistant', content: 'a14' });
  assert.deepEqual(sent[18], { role: 'user', content: 'q14' });
  assert.deepEqual(Object.keys(sent[0]).sort(), ['content', 'role'], 'no buttons or cards go to the server');
  assert.equal(ui.historyFor([{ role: 'bot', text: 'x'.repeat(5000) }])[0].content.length, 2000);
});

test('what is kept in the tab is read back safely', () => {
  const empty = { open: false, messages: [] };
  for (const junk of [null, undefined, '', 'not json', '[]', '{}', '{"v":2,"messages":[]}', '{"v":1}', '{"v":1,"messages":"x"}', 'null', '5']) assert.deepEqual(ui.readState(junk), empty, String(junk));

  const stored = JSON.stringify({
    v: 1,
    open: true,
    messages: [
      { role: 'user', text: 'hello' },
      { role: 'bot', text: 'Hi', actions: [{ label: 'See pricing', href: '/pricing' }, { label: 'Evil', href: 'https://evil.example' }, { label: 'a', href: '/a' }, { label: 'b', href: '/b' }, { label: 'c', href: '/c' }], cards: [CARD, { ...CARD, vehicle: 'truck' }] },
      { role: 'robot', text: 'who?' },
      { role: 'user', text: '   ' },
      { role: 'user', text: 5 },
      null,
      { role: 'user', text: 'x'.repeat(900) },
      { role: 'bot', text: 'y'.repeat(9000) },
    ],
  });
  const state = ui.readState(stored);
  assert.equal(state.open, true);
  assert.deepEqual(state.messages.map((m) => m.role), ['user', 'bot', 'user', 'bot']);
  assert.deepEqual(state.messages[1].actions, [{ label: 'See pricing', href: '/pricing' }, { label: 'a', href: '/a' }, { label: 'b', href: '/b' }], 'an unsafe button is dropped and at most three are kept');
  assert.deepEqual(state.messages[1].cards, [CARD]);
  assert.equal(state.messages[2].text.length, ui.MAX_CHARS);
  assert.equal(state.messages[3].text.length, 3000);
  assert.equal(ui.readState('{"v":1,"open":"yes","messages":[]}').open, false, 'only true opens the window');
});

test('only the latest 40 messages are kept in the tab, and a saved chat reads back the same', () => {
  const messages = [];
  for (let i = 0; i < 60; i++) messages.push({ role: i % 2 ? 'bot' : 'user', text: 'm' + i, ...(i % 2 ? { actions: [{ label: 'See pricing', href: '/pricing' }], cards: [CARD] } : {}) });
  const back = ui.readState(ui.packState({ open: true, messages }));
  assert.equal(back.messages.length, 40);
  assert.equal(back.messages[0].text, 'm20');
  assert.equal(back.messages[39].text, 'm59');
  assert.deepEqual(back, ui.readState(ui.packState(back)));
  assert.deepEqual(JSON.parse(ui.packState({ open: false, messages: [] })), { v: 1, open: false, messages: [] });
});

test('the starting questions are ones the instant answers really understand', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  assert.equal(ui.SUGGESTIONS.length, 6);
  for (const q of ui.SUGGESTIONS) {
    const r = await site.app.locals.chat.reply({ messages: [{ role: 'user', content: q }] }, { visitor: 'x' });
    assert.equal(r.mode, 'instant');
    assert.ok(!r.reply.includes('I’m not sure') && !/not sure/i.test(r.reply), `${q}: ${r.reply}`);
    assert.ok(r.actions.length > 0 || r.cards.length > 0, `${q} should lead somewhere`);
    assert.ok(q.length <= ui.MAX_CHARS);
  }
});

// ===== Rules for the code ===================================================================================

test('the chat script never turns text into HTML and only talks to /api/chat on this site', () => {
  const js = read('js', 'chat.js');
  for (const [what, pattern] of [
    ['innerHTML', /\.innerHTML/], ['outerHTML', /\.outerHTML/], ['insertAdjacentHTML', /insertAdjacentHTML/], ['document.write', /document\.write/], ['eval', /\beval\s*\(/],
    ['new Function', /new Function/], ['a style attribute', /setAttribute\(\s*['"]style/], ['cssText', /\.cssText/], ['a javascript: address', /javascript:/i], ['an address on another site', /https?:\/\//],
    ['a script or frame being added', /createElement\(\s*['"](script|iframe|object|embed)/],
  ]) {
    assert.doesNotMatch(js, pattern, `chat.js must not use ${what}`);
  }
  const addresses = new Set([...js.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((m) => m[1]));
  assert.deepEqual([...addresses], ['/api/chat']);
});

test('the chat uses only icons that are in the icon file', () => {
  const js = read('js', 'chat.js');
  const sprite = read('img', 'icons.svg');
  const used = new Set([...js.matchAll(/\bicon\(\s*'([a-z-]+)'/g)].map((m) => m[1]));
  for (const name of ['phone', 'mail', 'arrow', 'car', 'bike']) used.add(name); // picked by a variable
  assert.ok(used.size >= 9);
  for (const name of used) assert.ok(sprite.includes(`<symbol id="${name}"`), `icons.svg has no "${name}"`);
});

test('the chat style sheet is self-contained and styles every class the script uses', () => {
  const css = read('css', 'chat.css');
  const js = read('js', 'chat.js');
  assert.doesNotMatch(css, /url\(|@import/, 'nothing is loaded from another file');
  const important = css.split('\n').filter((line) => line.includes('!important'));
  assert.deepEqual(important, ['  .chat-launcher, .chat-panel { display: none !important; }'], '!important only to keep the window off a printed page');
  const classes = new Set();
  for (const m of js.matchAll(/class: '([^']+)'/g)) for (const name of m[1].split(/\s+/)) if (name.startsWith('chat-')) classes.add(name);
  const hooksOnly = new Set(['chat-typing', 'chat-problem']); // found by the script, not styled on their own
  assert.ok(classes.size >= 25, `found ${classes.size} classes`);
  for (const name of classes) {
    if (!hooksOnly.has(name)) assert.ok(css.includes('.' + name), `chat.css does not style .${name}`);
  }
  for (const state of ['.chat-lock', '.still', '.is-error', '.is-full']) assert.ok(css.includes(state), `chat.css should style ${state}`);
});

// ===== The pages ============================================================================================

const PUBLIC_URLS = ['/', '/book', '/lookup', '/pricing', '/terms', '/privacy', '/refunds', '/shipping', '/contact'];

test('every public page carries the chat, after the script it needs, and the operator dashboard does not', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const url of PUBLIC_URLS) {
    const { text } = await site.get(url);
    assert.ok(text.includes('<link rel="stylesheet" href="/css/chat.css">'), `${url} links the chat style sheet`);
    assert.equal(text.split('<script src="/js/chat.js"></script>').length - 1, 1, `${url} loads the chat script once`);
    assert.ok(text.indexOf('/js/common.js') > -1 && text.indexOf('/js/common.js') < text.indexOf('/js/chat.js'), `${url} loads common.js before chat.js`);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `${url} has an unfilled {{TOKEN}}`);
  }
  const dash = await site.get('/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(!dash.text.includes('chat.js') && !dash.text.includes('chat.css'), 'the dashboard has no chat button');
});

test('the chat files are served with the right types, as they are on disk', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const css = await site.get('/css/chat.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal(css.text, read('css', 'chat.css'));
  const js = await site.get('/js/chat.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(js.text, read('js', 'chat.js'));
  assert.match((await site.get('/img/icons.svg')).text, /<symbol id="chat"/);
});

test('the privacy page says what the chat does with what is typed, in every mode', async (t) => {
  const privacy = async (env) => {
    const site = await makeSite({ env });
    t.after(() => site.close());
    const res = await site.get('/privacy');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /\{\{[A-Z_]+\}\}/, 'no unfilled {{TOKEN}}');
    return res.text;
  };

  const ai = await privacy({ ANTHROPIC_API_KEY: AI_KEY });
  assert.match(ai, /<h2>Chat assistant<\/h2>/);
  assert.ok(ai.includes('sends what you typed in the chat, together with the last few messages of the same chat, to Anthropic, the company that makes the Claude AI model'));
  assert.ok(ai.includes('<li><strong>Anthropic</strong> writes the answers of the chat assistant'), 'Anthropic is in the list of who else sees it');
  assert.ok(ai.includes('We do not save what you type in the chat on our server'));
  assert.ok(ai.indexOf('Anthropic</strong> writes') < ai.indexOf('<h2>Chat assistant</h2>'), 'the list comes before the section it points to');

  for (const [what, env] of [['no key', {}], ['the AI limit at 0', { ANTHROPIC_API_KEY: AI_KEY, CHAT_DAILY_LIMIT: '0' }]]) {
    const plain = await privacy(env);
    assert.match(plain, /<h2>Chat assistant<\/h2>/, what);
    assert.ok(plain.includes('What you type in the chat is not sent to anyone else.'), what);
    assert.ok(!plain.includes('Anthropic'), `${what}: Anthropic is not mentioned when nothing is sent to it`);
  }

  for (const [what, env] of [['the chat off', { CHAT_ENABLED: 'off' }], ['the chat off with a key', { CHAT_ENABLED: 'off', ANTHROPIC_API_KEY: AI_KEY }]]) {
    const off = await privacy(env);
    assert.ok(!off.includes('Chat assistant') && !off.includes('Anthropic') && !off.includes('chat window'), `${what}: the page does not talk about a chat that is not there`);
    assert.ok(off.includes('Who else can see it') && off.includes('How long we keep it'), `${what}: the rest of the page is still there`);
  }
});
