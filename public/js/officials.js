/*
 * The owner's page for the logins of government officials and gate attendants: create one, set a new password, remove one.
 * The server decides who may do this (only the owner). Text goes on the page as text.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, api, post } = B;
  const $ = (id) => document.getElementById(id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // The page has two lists of the same kind of login. Everything that differs between them is here.
  const KINDS = [
    { word: 'official', api: '/api/dashboard/officials', key: 'officials', list: 'list', totals: 'totals', form: 'add-form', go: 'add-go', message: 'add-message', name: 'o-name', office: 'o-office', email: 'o-email', password: 'o-password',
      sub: (o) => o.office || 'No office given', empty: 'No official has a login yet. Create the first one above.', caption: 'Government officials with a login', head: 'Official',
      signedOut: 'The official was signed out and signs in again with it.' },
    { word: 'gate attendant', api: '/api/dashboard/attendants', key: 'attendants', list: 'list-a', totals: 'totals-a', form: 'add-form-a', go: 'add-go-a', message: 'add-message-a', name: 'a-name', office: null, email: 'a-email', password: 'a-password',
      sub: () => 'Gate attendant', empty: 'No gate attendant has a login yet. Create the first one above.', caption: 'Gate attendants with a login', head: 'Attendant',
      signedOut: 'The attendant was signed out and signs in again with it.' },
  ];

  function say(box, text, kind) {
    box.replaceChildren(text ? h('p', { class: 'msg ' + (kind || 'err'), role: kind === 'ok' ? 'status' : 'alert' }, text) : '');
  }

  function row(o, off, kind) {
    const message = h('div', { 'aria-live': 'polite' });
    const actions = h('div', { class: 'row' });

    function showStart() {
      actions.replaceChildren(
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-label': `New password for ${o.name}`, onclick: showPassword }, 'New password'),
        h('button', { class: 'btn btn-danger-outline btn-sm', type: 'button', 'aria-label': `Remove the login of ${o.name}`, onclick: showRemove }, 'Remove login')
      );
    }

    function showPassword() {
      const input = h('input', { class: 'input', type: 'password', minlength: '8', maxlength: '100', autocomplete: 'new-password', 'aria-label': `New password for ${o.name}` });
      const save = h('button', { class: 'btn btn-navy btn-sm', type: 'button' }, 'Save password');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await post(kind.api + '/' + encodeURIComponent(o.id) + '/password', { password: input.value });
          say(message, 'The new password is saved. ' + kind.signedOut, 'ok');
          showStart();
        } catch (err) {
          save.disabled = false;
          say(message, err.message);
        }
      });
      actions.replaceChildren(input, save, h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { say(message, ''); showStart(); } }, 'Cancel'));
      input.focus();
    }

    function showRemove() {
      const keep = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: showStart }, 'Keep login');
      const yes = h('button', { class: 'btn btn-danger btn-sm', type: 'button' }, 'Yes, remove it');
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          await post(kind.api + '/' + encodeURIComponent(o.id) + '/remove', {});
          await load(`The login of ${o.name} was removed.`);
        } catch (err) {
          yes.disabled = false;
          say(message, err.message);
        }
      });
      actions.replaceChildren(h('p', { class: 'cancel-ask' }, `Remove the login of ${o.name} (${o.email})? They are signed out at once and cannot sign in again.`), yes, keep);
      keep.focus(); // the safe choice is the one under the keyboard
    }

    showStart();
    return h(
      'tr',
      null,
      h('td', null, o.name, h('span', { class: 'sub' }, kind.sub(o))),
      h('td', null, o.email),
      h('td', { class: 'nowrap' }, S.formatDate(o.createdAt, off)),
      h('td', null, actions, message)
    );
  }

  function table(list, off, kind) {
    if (!list.length) return h('p', { class: 'muted' }, kind.empty);
    return h(
      'table',
      { class: 'table' },
      h('caption', { class: 'sr-only' }, kind.caption),
      h('thead', null, h('tr', null, [kind.head, 'Login (email)', 'Created', 'Actions'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, list.map((o) => row(o, off, kind)))
    );
  }

  async function load(note) {
    try {
      const [lists, cfg] = await Promise.all([Promise.all(KINDS.map((k) => api(k.api))), B.getConfig()]);
      $('updated').textContent = 'Updated ' + S.formatTime(B.now(), cfg.utcOffsetMinutes);
      KINDS.forEach((kind, i) => {
        const list = lists[i][kind.key];
        $(kind.totals).textContent = plural(list.length, kind.word) + ' with a login';
        $(kind.list).replaceChildren(table(list, cfg.utcOffsetMinutes, kind));
      });
      $('notice').replaceChildren(note ? h('div', { class: 'banner info', role: 'status' }, note) : '');
    } catch (err) {
      $('updated').textContent = 'Could not load';
      $('notice').replaceChildren(h('div', { class: 'banner bad' }, err.status === 403 ? 'This page is only for the parking owner. ' + err.message : err.message));
    }
  }

  for (const kind of KINDS) {
    $(kind.form).addEventListener('submit', async (event) => {
      event.preventDefault();
      const go = $(kind.go);
      const box = $(kind.message);
      const body = { name: $(kind.name).value, email: $(kind.email).value, password: $(kind.password).value };
      if (kind.office) body.office = $(kind.office).value;
      if (!body.name.trim() || !body.email.trim() || body.password.length < 8) return say(box, 'Enter the name, the email and a password of at least 8 characters.');
      go.disabled = true;
      say(box, '');
      try {
        const done = await post(kind.api, body);
        const made = done[kind.key.slice(0, -1)];
        $(kind.form).reset();
        say(box, `The login for ${made.name} is ready. They sign in at the Sign in page with ${made.email} and the password you chose.`, 'ok');
        await load();
      } catch (err) {
        say(box, err.message);
      } finally {
        go.disabled = false;
      }
    });
  }

  load();
})();
