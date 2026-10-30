/*
 * The chat assistant: a button in the corner of the page that opens a chat window.
 *
 * What a visitor types goes to /api/chat on this same site and nowhere else. The answer comes back as plain text with a
 * few buttons and cards, and all of it is put on the page as text, never as HTML. The conversation is kept in this
 * browser tab only (sessionStorage), so it follows the visitor from page to page and is gone when the tab is closed.
 *
 * The first half of this file is plain functions with no page in sight, so the tests can load them in Node.
 */
(function () {
  'use strict';

  const MAX_CHARS = 500; // the longest message the server takes
  const COUNT_FROM = 400; // the "400 / 500" counter appears from here
  const SEND_LAST = 20; // the server takes at most this many messages in one go
  const KEEP = 40; // messages kept in the tab
  const TIMEOUT_MS = 45 * 1000;
  const MIN_TYPING_MS = 650; // an instant answer waits a moment, so the page does not jump
  const STORE_KEY = 'bayfind.chat';

  const SUGGESTIONS = ['What does parking cost?', 'Are bays free now?', 'How do I book?', 'Find my booking', 'Cancel or get a refund', 'Contact the lot'];

  // ---- Plain functions ---------------------------------------------------------------------------------------------

  // "Total is **₹80**." becomes [{ text: 'Total is ', bold: false }, { text: '₹80', bold: true }, { text: '.', bold: false }].
  // A ** with no partner is just text.
  function inline(raw) {
    const text = String(raw)
      .replace(/\[([^\]\n]+)\]\((?:[^)\n]*)\)/g, '$1') // a markdown link keeps its words only: the page never links to anywhere else
      .replace(/`+/g, '');
    const parts = text.split('**');
    if (parts.length % 2 === 0) {
      const tail = parts.pop();
      parts[parts.length - 1] += '**' + tail;
    }
    const runs = [];
    parts.forEach((part, i) => {
      if (part) runs.push({ text: part, bold: i % 2 === 1 });
    });
    return runs;
  }

  // An answer as blocks: paragraphs, bullet lists ("- ") and numbered lists ("1. "). Blank lines separate paragraphs.
  function parseRich(raw) {
    const blocks = [];
    let list = null;
    let para = [];
    const endPara = () => {
      if (para.length) blocks.push({ type: 'p', runs: inline(para.join('\n')) });
      para = [];
    };
    for (const line of String(raw).replace(/\r\n?/g, '\n').split('\n')) {
      const t = line.trim();
      let m;
      if (!t) {
        endPara();
        list = null;
      } else if ((m = /^[-*•]\s+(.+)$/.exec(t))) {
        endPara();
        if (!list || list.type !== 'ul') blocks.push((list = { type: 'ul', items: [] }));
        list.items.push(inline(m[1]));
      } else if ((m = /^(\d{1,2})[.)]\s+(.+)$/.exec(t))) {
        endPara();
        if (!list || list.type !== 'ol') blocks.push((list = { type: 'ol', start: Number(m[1]), items: [] }));
        list.items.push(inline(m[2]));
      } else if ((m = /^#{1,6}\s+(.+)$/.exec(t))) {
        endPara();
        list = null;
        blocks.push({ type: 'p', runs: [{ text: m[1].replace(/\*\*/g, ''), bold: true }] });
      } else if (/^([-*_])\1{2,}$/.test(t)) {
        endPara();
        list = null;
      } else {
        list = null;
        para.push(t);
      }
    }
    endPara();
    return blocks;
  }

  // The only places a button may take the visitor: a page of this site, a phone number, an email address.
  function safeHref(href) {
    if (typeof href !== 'string' || href.length > 300) return null;
    if (/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%+#@:,]*$/.test(href)) return href;
    if (/^tel:[+\d]{5,20}$/.test(href)) return href;
    if (/^mailto:[^\s<>"'\\]{3,200}$/.test(href) && href.includes('@')) return href;
    return null;
  }

  function safeAction(a) {
    if (!a || typeof a.label !== 'string' || !a.label.trim() || a.label.length > 80) return null;
    const href = safeHref(a.href);
    return href ? { label: a.label.trim(), href } : null;
  }

  const isInt = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  const isText = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;

  // The free-bays card. Anything that is not exactly what the server sends is dropped.
  function safeCard(c) {
    if (!c || c.kind !== 'bays' || (c.vehicle !== 'car' && c.vehicle !== 'bike')) return null;
    if (!isText(c.label, 40) || !isText(c.window, 80) || !isInt(c.hours, 24) || !isInt(c.free, 100000) || !isInt(c.total, 100000) || c.free > c.total) return null;
    const zones = Array.isArray(c.zones)
      ? c.zones.slice(0, 12).filter((z) => z && isText(z.name, 30) && isInt(z.free, 100000)).map((z) => ({ name: z.name, free: z.free }))
      : [];
    return { kind: 'bays', vehicle: c.vehicle, label: c.label, window: c.window, hours: c.hours, free: c.free, total: c.total, zones };
  }

  // What is sent to the server: the latest messages, as text only.
  function historyFor(messages) {
    return messages.slice(-SEND_LAST).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text.slice(0, 2000) }));
  }

  // The chat kept in the tab: { open, messages: [{ role: 'user' | 'bot', text, actions?, cards? }] }. Whatever is stored is
  // checked again on the way out, so a damaged or tampered value can only ever give an empty chat.
  function readState(stored) {
    const empty = { open: false, messages: [] };
    let data;
    try {
      data = JSON.parse(stored);
    } catch (err) {
      return empty;
    }
    if (!data || data.v !== 1 || !Array.isArray(data.messages)) return empty;
    const messages = [];
    for (const m of data.messages.slice(-KEEP)) {
      if (!m || (m.role !== 'user' && m.role !== 'bot') || typeof m.text !== 'string' || !m.text.trim()) continue;
      if (m.role === 'user') {
        messages.push({ role: 'user', text: m.text.slice(0, MAX_CHARS) });
      } else {
        messages.push({
          role: 'bot',
          text: m.text.slice(0, 3000),
          actions: (Array.isArray(m.actions) ? m.actions : []).map(safeAction).filter(Boolean).slice(0, 3),
          cards: (Array.isArray(m.cards) ? m.cards : []).map(safeCard).filter(Boolean).slice(0, 2),
        });
      }
    }
    return { open: data.open === true, messages };
  }

  const packState = (state) => JSON.stringify({ v: 1, open: state.open, messages: state.messages.slice(-KEEP) });

  const helpers = { inline, parseRich, safeHref, safeAction, safeCard, historyFor, readState, packState, SUGGESTIONS, MAX_CHARS };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;

  // ---- The chat window ---------------------------------------------------------------------------------------------

  if (typeof window === 'undefined' || !window.Bayfind || typeof document === 'undefined') return;
  const B = window.Bayfind;
  const h = B.h;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function mount(cfg) {
    const ai = Boolean(cfg.chat.ai);
    const siteName = typeof cfg.siteName === 'string' && cfg.siteName.trim() ? cfg.siteName.trim() : 'Parking';
    const letter = (Array.from(siteName)[0] || 'P').toUpperCase();
    const small = window.matchMedia('(max-width: 640px), (max-height: 500px)'); // phones, also on their side: the window fills the screen
    const touch = window.matchMedia('(pointer: coarse)');
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

    let saved = { open: false, messages: [] };
    try {
      saved = readState(window.sessionStorage.getItem(STORE_KEY));
    } catch (err) {
      // storage blocked: the chat works, it just does not follow the visitor to the next page
    }
    const state = { open: false, busy: false, leaving: false, messages: saved.messages };

    function persist() {
      try {
        // A window that is closed by following one of its own buttons is not reopened on the page that opens.
        window.sessionStorage.setItem(STORE_KEY, packState({ open: state.open && !state.leaving, messages: state.messages }));
      } catch (err) {
        // private window or blocked storage: fine
      }
    }

    // ---- The pieces ----
    const launcher = h(
      'button',
      { type: 'button', class: 'chat-launcher', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'chat-panel' },
      B.icon('chat'),
      h('span', null, 'Ask us')
    );

    const title = h('h2', { id: 'chat-title', class: 'chat-title', tabindex: '-1' }, siteName + ' assistant');
    const newBtn = h('button', { type: 'button', class: 'chat-icon-btn', 'aria-label': 'Start a new chat', title: 'New chat' }, B.icon('refresh'));
    const closeBtn = h('button', { type: 'button', class: 'chat-icon-btn', 'aria-label': 'Close chat', title: 'Close' }, B.icon('close'));
    const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation', tabindex: '0' });
    const input = h('textarea', {
      id: 'chat-input',
      class: 'chat-input',
      rows: '1',
      maxlength: String(MAX_CHARS),
      placeholder: 'Ask about parking…',
      autocomplete: 'off',
      enterkeyhint: 'send',
      'aria-describedby': 'chat-note',
    });
    const sendBtn = h('button', { type: 'submit', class: 'chat-send', 'aria-label': 'Send', disabled: true }, B.icon('send'));
    const form = h('form', { class: 'chat-form', novalidate: true }, h('label', { class: 'sr-only', for: 'chat-input' }, 'Your question'), input, sendBtn);
    const count = h('span', { class: 'chat-count', hidden: true });
    const note = h(
      'p',
      { id: 'chat-note', class: 'chat-note' },
      ai ? 'Some answers are written by AI and can be wrong, so check prices on the booking page. ' : 'Answers come from this website’s own settings. ',
      'Never type card details here. ',
      h('a', { href: '/privacy' }, 'Privacy'),
      count
    );
    const live = h('span', { class: 'chat-live', 'aria-hidden': 'true' });
    const panel = h(
      'section',
      { id: 'chat-panel', class: 'chat-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'chat-title', hidden: true },
      h(
        'div', // not a <header>: inside a window that would count as a second page banner
        { class: 'chat-head on-dark' },
        h('span', { class: 'chat-avatar', 'aria-hidden': 'true' }, letter),
        h('div', { class: 'chat-who' }, title, h('p', { class: 'chat-sub' }, live, ai ? 'AI assistant' : 'Instant answers')),
        h('div', { class: 'chat-head-actions' }, newBtn, closeBtn)
      ),
      log,
      form,
      note
    );
    document.body.append(launcher, panel);

    // ---- What goes in the conversation ----
    function richNodes(text) {
      return parseRich(text).map((block) => {
        const runs = (list) => list.map((r) => (r.bold ? h('strong', null, r.text) : r.text));
        if (block.type === 'p') return h('p', null, runs(block.runs));
        const items = block.items.map((item) => h('li', null, runs(item)));
        return block.type === 'ul' ? h('ul', null, items) : h('ol', block.start > 1 ? { start: String(block.start) } : null, items);
      });
    }

    function cardNode(c, animate) {
      const pct = c.total ? Math.round((c.free / c.total) * 100) : 0;
      const fill = h('i');
      const node = h(
        'div',
        { class: 'chat-card' + (c.free === 0 ? ' is-full' : '') },
        h('div', { class: 'chat-card-top' }, B.icon(c.vehicle), h('b', null, c.label)),
        h('p', { class: 'chat-card-when' }, c.window),
        h('p', { class: 'chat-card-count' }, c.free === 0 ? h('b', null, 'No bays free') : [h('b', null, String(c.free)), ' of ' + c.total + ' bays free']),
        h('div', { class: 'chat-meter', 'aria-hidden': 'true' }, fill),
        c.zones.length
          ? h('ul', { class: 'chat-zones' }, c.zones.map((z) => h('li', null, z.name + ' ', h('b', null, String(z.free)), h('span', { class: 'sr-only' }, ' free'))))
          : null
      );
      if (animate) {
        fill.style.width = '0';
        requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = pct + '%')));
      } else {
        fill.style.width = pct + '%';
      }
      return node;
    }

    function actionsNode(actions) {
      return h(
        'div',
        { class: 'chat-actions' },
        actions.map((a) => {
          const kind = a.href.startsWith('tel:') ? 'phone' : a.href.startsWith('mailto:') ? 'mail' : 'arrow';
          return h('a', { class: 'chat-action', href: a.href }, h('span', null, a.label), B.icon(kind, 'ico-sm'));
        })
      );
    }

    function messageNode(msg, animate) {
      if (msg.role === 'user') {
        return h('div', { class: 'chat-msg me' }, h('div', { class: 'chat-bubble' }, h('span', { class: 'sr-only' }, 'You: '), msg.text));
      }
      const node = h('div', { class: 'chat-msg bot' }, h('div', { class: 'chat-bubble' }, h('span', { class: 'sr-only' }, 'Assistant: '), richNodes(msg.text)));
      for (const card of msg.cards || []) node.append(cardNode(card, animate));
      if (msg.actions && msg.actions.length) node.append(actionsNode(msg.actions));
      return node;
    }

    function welcomeNode() {
      const hello = ai
        ? `Hi! I’m the ${siteName} assistant, an AI. I can help with prices, free bays, booking and refunds. What would you like to know?`
        : `Hi! I’m the ${siteName} assistant. I can help with prices, free bays, booking and refunds. What would you like to know?`;
      return h(
        'div',
        { class: 'chat-welcome' },
        h('div', { class: 'chat-msg bot' }, h('div', { class: 'chat-bubble' }, h('span', { class: 'sr-only' }, 'Assistant: '), h('p', null, hello))),
        h('ul', { class: 'chat-suggest', 'aria-label': 'Things you can ask' }, SUGGESTIONS.map((q) => h('li', null, h('button', { type: 'button', class: 'chat-chip', onclick: () => send(q) }, q))))
      );
    }

    function typingNode() {
      return h(
        'div',
        { class: 'chat-msg bot chat-typing' },
        h('div', { class: 'chat-bubble' }, h('span', { class: 'sr-only' }, 'The assistant is typing'), h('span', { class: 'chat-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')))
      );
    }

    function errorNode(message) {
      const again = h('button', { type: 'button', class: 'chat-retry', onclick: () => ask() }, 'Try again');
      return h('div', { class: 'chat-msg bot chat-problem' }, h('div', { class: 'chat-bubble is-error' }, h('p', null, message), again));
    }

    // ---- Scrolling and sizes ----
    const toEnd = (smooth) => log.scrollTo({ top: log.scrollHeight, behavior: smooth && !calm.matches ? 'smooth' : 'auto' });

    // A long answer is shown from its top, so the first lines are not scrolled away before they are read.
    function reveal(node) {
      if (node.offsetHeight > log.clientHeight - 32) log.scrollTo({ top: Math.max(0, node.offsetTop - 12), behavior: calm.matches ? 'auto' : 'smooth' });
      else toEnd(true);
    }

    function resize() {
      input.style.height = 'auto';
      const extra = input.offsetHeight - input.clientHeight;
      input.style.height = Math.min(input.scrollHeight + extra, 132) + 'px';
    }

    // On a phone the window fills the visible part of the screen, also above the on-screen keyboard.
    function fit() {
      const vv = window.visualViewport;
      if (!vv || !state.open || !small.matches) {
        panel.style.removeProperty('--vvh');
        panel.style.removeProperty('--vvt');
        return;
      }
      panel.style.setProperty('--vvh', vv.height + 'px');
      panel.style.setProperty('--vvt', vv.offsetTop + 'px');
    }

    function layout() {
      const sheet = state.open && small.matches;
      document.documentElement.classList.toggle('chat-lock', sheet);
      panel.setAttribute('aria-modal', sheet ? 'true' : 'false');
      fit();
    }

    function sync() {
      const text = input.value;
      sendBtn.disabled = state.busy || !text.trim();
      newBtn.disabled = state.busy || state.messages.length === 0;
      for (const chip of log.querySelectorAll('.chat-chip, .chat-retry')) chip.disabled = state.busy;
      const showCount = text.length >= COUNT_FROM;
      count.hidden = !showCount;
      count.textContent = showCount ? ` ${text.length} / ${MAX_CHARS}` : '';
    }

    // ---- Opening and closing ----
    function open(options) {
      const quiet = Boolean(options && options.quiet); // quiet: reopening on the next page, so no animation and no focus grab
      if (state.open) return;
      state.open = true;
      panel.classList.toggle('still', quiet);
      panel.hidden = false;
      launcher.hidden = true;
      launcher.setAttribute('aria-expanded', 'true');
      layout();
      resize();
      toEnd(false);
      if (quiet) {
        requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('still')));
      } else {
        // On a phone the keyboard would cover half of the window, so the window gets the focus, not the box.
        (touch.matches || small.matches ? title : input).focus({ preventScroll: true });
      }
      persist();
    }

    function close(options) {
      if (!state.open) return;
      state.open = false;
      panel.hidden = true;
      launcher.hidden = false;
      launcher.setAttribute('aria-expanded', 'false');
      layout();
      if (!options || options.focus !== false) launcher.focus({ preventScroll: true });
      persist();
    }

    // ---- Messages ----
    function removeProblems() {
      for (const node of log.querySelectorAll('.chat-problem')) node.remove();
    }

    function push(msg) {
      state.messages.push(msg);
      if (state.messages.length > KEEP) state.messages.splice(0, state.messages.length - KEEP);
      const welcome = log.querySelector('.chat-welcome');
      if (welcome) welcome.remove();
      const node = messageNode(msg, true);
      log.append(node);
      persist();
      if (msg.role === 'bot') reveal(node);
      else toEnd(true);
    }

    function shutDown() {
      // The site owner has switched the chat off since this page was loaded.
      close({ focus: false });
      launcher.remove();
      panel.remove();
      try {
        window.sessionStorage.removeItem(STORE_KEY);
      } catch (err) {
        // fine
      }
    }

    async function ask() {
      if (state.busy) return;
      state.busy = true;
      removeProblems();
      const typing = typingNode();
      log.append(typing);
      toEnd(true);
      sync();
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const r = await B.api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ messages: historyFor(state.messages) }),
          signal: controller.signal,
        });
        if (!r || typeof r.reply !== 'string' || !r.reply.trim()) throw new B.ApiError(200, 'bad_reply', 'The answer could not be read. Please try again.');
        if (r.mode === 'instant') {
          const wait = MIN_TYPING_MS - (Date.now() - started);
          if (wait > 0) await sleep(wait);
        }
        typing.remove();
        push({
          role: 'bot',
          text: r.reply.slice(0, 3000),
          actions: (Array.isArray(r.actions) ? r.actions : []).map(safeAction).filter(Boolean).slice(0, 3),
          cards: (Array.isArray(r.cards) ? r.cards : []).map(safeCard).filter(Boolean).slice(0, 2),
        });
      } catch (err) {
        typing.remove();
        if (err && err.code === 'chat_off') {
          shutDown();
          return;
        }
        const message = controller.signal.aborted
          ? 'The assistant is taking too long to answer. Please try again.'
          : err && err.message
            ? err.message
            : 'Something went wrong. Please try again.';
        log.append(errorNode(message));
        toEnd(true);
      } finally {
        clearTimeout(timer);
        state.busy = false;
        sync();
      }
    }

    function send(text) {
      const clean = String(text).trim().slice(0, MAX_CHARS);
      if (!clean || state.busy) return;
      push({ role: 'user', text: clean });
      input.value = '';
      resize();
      ask();
    }

    function newChat() {
      if (state.busy) return;
      state.messages = [];
      persist();
      log.replaceChildren(welcomeNode());
      sync();
      toEnd(false);
      input.focus({ preventScroll: true });
    }

    // ---- Wiring ----
    launcher.addEventListener('click', () => open());
    closeBtn.addEventListener('click', () => close());
    newBtn.addEventListener('click', newChat);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(input.value);
    });
    input.addEventListener('input', () => {
      resize();
      sync();
    });
    input.addEventListener('keydown', (e) => {
      // Enter sends, Shift+Enter starts a new line. A key that is only choosing a character (Japanese, Hindi and so on) is left alone.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send(input.value);
      }
    });

    const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab' || !small.matches) return;
      // In the full-screen window, Tab stays inside it.
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === title)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    // A button that opens another page closes the window there, so the page that opens is not hidden behind it.
    panel.addEventListener('click', (e) => {
      const link = e.target instanceof Element ? e.target.closest('a[href^="/"]') : null;
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      state.leaving = true;
      persist();
      setTimeout(() => {
        state.leaving = false; // the page did not change after all
        persist();
      }, 1500);
    });

    const media = (query, fn) => (query.addEventListener ? query.addEventListener('change', fn) : query.addListener(fn));
    media(small, layout);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fit);
      window.visualViewport.addEventListener('scroll', fit);
    }

    // ---- Start ----
    if (state.messages.length) {
      for (const msg of state.messages) log.append(messageNode(msg, false));
      if (state.messages[state.messages.length - 1].role === 'user') {
        // The page was left while a question was being answered.
        log.append(errorNode('That question did not get an answer. Please try again.'));
      }
    } else {
      log.append(welcomeNode());
    }
    sync();
    if (saved.open && !small.matches) open({ quiet: true });
  }

  B.getConfig().then(
    (cfg) => {
      if (cfg && cfg.chat && cfg.chat.enabled) mount(cfg);
    },
    () => {
      // No settings, no chat: the rest of the page is not affected.
    }
  );
})();
