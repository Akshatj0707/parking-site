/*
 * The owner's page for the logins of government officials: create one, set a new password, remove one.
 * The server decides who may do this (only the owner). Text goes on the page as text.
 */
(function () {
  'use strict';

  const B = window.Bayfind;
  const { S, h, api, post } = B;
  const $ = (id) => document.getElementById(id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function say(box, text, kind) {
    box.replaceChildren(text ? h('p', { class: 'msg ' + (kind || 'err'), role: kind === 'ok' ? 'status' : 'alert' }, text) : '');
  }

  function row(o, off) {
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
          await post('/api/dashboard/officials/' + encodeURIComponent(o.id) + '/password', { password: input.value });
          say(message, 'The new password is saved. The official was signed out and signs in again with it.', 'ok');
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
          await post('/api/dashboard/officials/' + encodeURIComponent(o.id) + '/remove', {});
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
      h('td', null, o.name, h('span', { class: 'sub' }, o.office || 'No office given')),
      h('td', null, o.email),
      h('td', { class: 'nowrap' }, S.formatDate(o.createdAt, off)),
      h('td', null, actions, message)
    );
  }

  function table(list, off) {
    if (!list.length) return h('p', { class: 'muted' }, 'No official has a login yet. Create the first one above.');
    return h(
      'table',
      { class: 'table' },
      h('caption', { class: 'sr-only' }, 'Government officials with a login'),
      h('thead', null, h('tr', null, ['Official', 'Login (email)', 'Created', 'Actions'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, list.map((o) => row(o, off)))
    );
  }

  async function load(note) {
    try {
      const [d, cfg] = await Promise.all([api('/api/dashboard/officials'), B.getConfig()]);
      $('updated').textContent = 'Updated ' + S.formatTime(B.now(), cfg.utcOffsetMinutes);
      $('totals').textContent = plural(d.officials.length, 'official') + ' with a login';
      $('list').replaceChildren(table(d.officials, cfg.utcOffsetMinutes));
      $('notice').replaceChildren(note ? h('div', { class: 'banner info', role: 'status' }, note) : '');
    } catch (err) {
      $('updated').textContent = 'Could not load';
      $('notice').replaceChildren(h('div', { class: 'banner bad' }, err.status === 403 ? 'This page is only for the parking owner. ' + err.message : err.message));
    }
  }

  $('add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const go = $('add-go');
    const box = $('add-message');
    const body = { name: $('o-name').value, office: $('o-office').value, email: $('o-email').value, password: $('o-password').value };
    if (!body.name.trim() || !body.email.trim() || body.password.length < 8) return say(box, 'Enter the name, the email and a password of at least 8 characters.');
    go.disabled = true;
    say(box, '');
    try {
      const done = await post('/api/dashboard/officials', body);
      $('add-form').reset();
      say(box, `The login for ${done.official.name} is ready. They sign in at the Sign in page with ${done.official.email} and the password you chose.`, 'ok');
      await load();
    } catch (err) {
      say(box, err.message);
    } finally {
      go.disabled = false;
    }
  });

  load();
})();
