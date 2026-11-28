'use strict';

/*
 * Email to customers. It sends five kinds of message: "your booking was cancelled" (with the refund), when the admin
 * cancels a paid booking, "you cancelled your booking" with what comes back, when the customer cancels it themselves, "your
 * parking ends soon" for a parked vehicle, the link to set a new password, and "your password was changed" once it is. It talks to an email service over HTTPS (Brevo or Resend), not over SMTP, because free hosts
 * such as Render's free size block the SMTP ports. Nothing here can break a cancellation: send() never throws, and the
 * route that cancels reports in plain words whether the email went.
 *
 * Settings (Render, Environment; the key is never kept in a file on GitHub):
 *   EMAIL_API_KEY    the service's API key
 *   EMAIL_FROM       the sender address (it must be verified in the email service)
 *   EMAIL_FROM_NAME  optional, the name customers see (default: the site name)
 *   EMAIL_PROVIDER   brevo (default) or resend
 */

const PROVIDERS = {
  brevo: { label: 'Brevo', url: 'https://api.brevo.com/v3/smtp/email' },
  resend: { label: 'Resend', url: 'https://api.resend.com/emails' },
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// a***@gmail.com: enough for the admin to see where it went, without printing the whole address in logs and pages
function maskEmail(email) {
  const at = String(email).lastIndexOf('@');
  if (at < 1) return '***';
  return `${String(email)[0]}***${String(email).slice(at)}`;
}

function createMailer({ config, fetchImpl = globalThis.fetch, log = console, timeoutMs = 8000, urls = {} }) {
  const cfg = config.email;
  const enabled = Boolean(cfg && cfg.enabled);

  // Always resolves: { status: 'sent' } or { status: 'failed', reason } or { status: 'not_set_up' }.
  async function send({ to, subject, text, html }) {
    if (!enabled) return { status: 'not_set_up' };
    const provider = PROVIDERS[cfg.provider];
    const url = urls[cfg.provider] || provider.url;
    let request;
    if (cfg.provider === 'brevo') {
      request = {
        headers: { 'api-key': cfg.apiKey, accept: 'application/json', 'content-type': 'application/json' },
        body: { sender: { name: cfg.fromName, email: cfg.from }, to: [{ email: to }], subject, htmlContent: html }, // Brevo takes one content field per request
      };
    } else {
      request = {
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: { from: `${cfg.fromName} <${cfg.from}>`, to: [to], subject, html, text },
      };
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { status: 'sent' };
      let detail = '';
      try {
        detail = String(await res.text()).replace(/\s+/g, ' ').slice(0, 160);
      } catch (err) {
        // no body
      }
      log.error(`${provider.label} refused the email to ${maskEmail(to)} (HTTP ${res.status}): ${detail}`);
      return { status: 'failed', reason: `${provider.label} answered HTTP ${res.status}` };
    } catch (err) {
      const reason = err && err.name === 'TimeoutError' ? `${provider.label} did not answer in time` : `${provider.label} could not be reached`;
      log.error(`The email to ${maskEmail(to)} was not sent: ${reason}.`);
      return { status: 'failed', reason };
    }
  }

  return { enabled, provider: enabled ? PROVIDERS[cfg.provider].label : null, send };
}

// The words of the message. `row` is the booking as the admin sees it (bookings.operatorRow); `refunded` is false when the
// refund did not go through yet.
function cancellationEmail({ siteName, supportEmail, name, row, amountText, refundId, refunded }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const lines = [
    `Hello ${first},`,
    '',
    `The parking owner has cancelled your booking ${row.ref} at ${siteName}. We are sorry for the trouble.`,
    '',
    'Your booking:',
    `  Reference: ${row.ref}`,
    `  Vehicle:   ${row.vehicleLabel}, ${row.plate}`,
    `  Bay:       ${row.bay} (${row.zone})`,
    `  Time:      ${row.window}`,
    `  Paid:      ${amountText}`,
    '',
  ];
  if (refunded) {
    lines.push(
      `Your full payment of ${amountText} is being refunded to the payment method you used.${refundId ? ` The refund number is ${refundId}.` : ''}`,
      'It usually reaches you in 5 to 10 working days. You do not need to do anything.'
    );
  } else {
    lines.push(
      `We could not send the refund of ${amountText} automatically yet. The parking owner has been told and will send it again.`,
      'You do not need to pay anything or do anything.'
    );
  }
  if (supportEmail) lines.push('', `Questions? Write to ${supportEmail} and quote ${row.ref}.`);
  lines.push('', `${siteName}`);
  const subject = refunded ? `Your parking booking ${row.ref} was cancelled and refunded` : `Your parking booking ${row.ref} was cancelled`;
  const text = lines.join('\n');

  const li = (label, value) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${label}</td><td style="padding:2px 0"><b>${escapeHtml(value)}</b></td></tr>`;
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:34rem">' +
    `<p>Hello ${escapeHtml(first)},</p>` +
    `<p>The parking owner has cancelled your booking <b>${escapeHtml(row.ref)}</b> at ${escapeHtml(siteName)}. We are sorry for the trouble.</p>` +
    '<table style="border-collapse:collapse;margin:12px 0">' +
    li('Reference', row.ref) +
    li('Vehicle', `${row.vehicleLabel}, ${row.plate}`) +
    li('Bay', `${row.bay} (${row.zone})`) +
    li('Time', row.window) +
    li('Paid', amountText) +
    '</table>' +
    (refunded
      ? `<p>Your full payment of <b>${escapeHtml(amountText)}</b> is being refunded to the payment method you used.${refundId ? ` The refund number is ${escapeHtml(refundId)}.` : ''} It usually reaches you in 5 to 10 working days. You do not need to do anything.</p>`
      : `<p>We could not send the refund of <b>${escapeHtml(amountText)}</b> automatically yet. The parking owner has been told and will send it again. You do not need to pay anything or do anything.</p>`) +
    (supportEmail ? `<p>Questions? Write to ${escapeHtml(supportEmail)} and quote ${escapeHtml(row.ref)}.</p>` : '') +
    `<p>${escapeHtml(siteName)}</p></div>`;
  return { subject, text, html };
}

// The message to a customer who cancelled their own booking. `refundText` says what happens to the money, in a sentence.
function customerCancelEmail({ siteName, supportEmail, name, row, amountText, refundText }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const lines = [
    `Hello ${first},`,
    '',
    `You cancelled your booking ${row.ref} at ${siteName}. The bay is free again.`,
    '',
    'Your booking:',
    `  Reference: ${row.ref}`,
    `  Vehicle:   ${row.vehicleLabel}, ${row.plate}`,
    `  Bay:       ${row.bay} (${row.zone})`,
    `  Time:      ${row.window}`,
    `  Paid:      ${amountText}`,
    '',
    refundText,
  ];
  if (supportEmail) lines.push('', `Questions? Write to ${supportEmail} and quote ${row.ref}.`);
  lines.push('', `${siteName}`);
  const li = (label, value) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${label}</td><td style="padding:2px 0"><b>${escapeHtml(value)}</b></td></tr>`;
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:34rem">' +
    `<p>Hello ${escapeHtml(first)},</p>` +
    `<p>You cancelled your booking <b>${escapeHtml(row.ref)}</b> at ${escapeHtml(siteName)}. The bay is free again.</p>` +
    '<table style="border-collapse:collapse;margin:12px 0">' +
    li('Reference', row.ref) +
    li('Vehicle', `${row.vehicleLabel}, ${row.plate}`) +
    li('Bay', `${row.bay} (${row.zone})`) +
    li('Time', row.window) +
    li('Paid', amountText) +
    '</table>' +
    `<p>${escapeHtml(refundText)}</p>` +
    (supportEmail ? `<p>Questions? Write to ${escapeHtml(supportEmail)} and quote ${escapeHtml(row.ref)}.</p>` : '') +
    `<p>${escapeHtml(siteName)}</p></div>`;
  return { subject: `You cancelled your parking booking ${row.ref}`, text: lines.join('\n'), html };
}

// The link to set a new password. It is valid for `minutes` and works once.
function passwordResetEmail({ siteName, supportEmail, name, link, minutes }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const lines = [
    `Hello ${first},`,
    '',
    `Someone asked to set a new password for your ${siteName} account. To choose one, open this link:`,
    '',
    link,
    '',
    `The link works for ${minutes} minutes and only once. If you did not ask for this, ignore this email: your password stays as it is.`,
  ];
  if (supportEmail) lines.push('', `Questions? Write to ${supportEmail}.`);
  lines.push('', siteName);
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:34rem">' +
    `<p>Hello ${escapeHtml(first)},</p>` +
    `<p>Someone asked to set a new password for your ${escapeHtml(siteName)} account.</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0b1530;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Choose a new password</a></p>` +
    `<p>If the button does not work, copy this address into your browser:<br>${escapeHtml(link)}</p>` +
    `<p>The link works for ${minutes} minutes and only once. If you did not ask for this, ignore this email: your password stays as it is.</p>` +
    (supportEmail ? `<p>Questions? Write to ${escapeHtml(supportEmail)}.</p>` : '') +
    `<p>${escapeHtml(siteName)}</p></div>`;
  return { subject: `Set a new password for ${siteName}`, text: lines.join('\n'), html };
}

// "Your password was changed", sent after a customer sets a new password with the emailed link. It never holds the password or a
// link that signs anyone in. `when` is the lot's clock; `link` is the page that asks for a new reset link (empty when the site
// does not know its own address), for the customer who did not do this.
function passwordChangedEmail({ siteName, supportEmail, name, when, link }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const next = link
    ? `If it was not you, choose a new password now. Open this page and ask for a new link:\n${link}`
    : 'If it was not you, choose a new password now: open the sign-in page, press "Forgot your password?" and follow the link we email you.';
  const lines = [
    `Hello ${first},`,
    '',
    `The password of your ${siteName} account was changed on ${when}. It was done with the link we emailed you, and you were signed out on every other device.`,
    '',
    'If it was you, there is nothing more to do.',
    '',
    next,
  ];
  if (supportEmail) lines.push('', `Still worried? Write to ${supportEmail} and we will help.`);
  lines.push('', siteName);
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:34rem">' +
    `<p>Hello ${escapeHtml(first)},</p>` +
    `<p>The password of your ${escapeHtml(siteName)} account was changed on <b>${escapeHtml(when)}</b>. It was done with the link we emailed you, and you were signed out on every other device.</p>` +
    '<p>If it was you, there is nothing more to do.</p>' +
    (link
      ? `<p>If it was <b>not</b> you, choose a new password now:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0b1530;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Ask for a new link</a></p>`
      : `<p>${escapeHtml(next)}</p>`) +
    (supportEmail ? `<p>Still worried? Write to ${escapeHtml(supportEmail)} and we will help.</p>` : '') +
    `<p>${escapeHtml(siteName)}</p></div>`;
  return { subject: `Your ${siteName} password was changed`, text: lines.join('\n'), html };
}

// "Your parking ends soon", sent once to a parked customer a few minutes before the booked end. `link` is the pass page, where
// more hours can be added; it is empty when the site does not know its own address.
function endingSoonEmail({ siteName, supportEmail, name, row, until, minutesLeft, link, maxHours, graceMinutes, rateText }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const more = link ? `Need more time? Open your pass and add up to ${maxHours} more hours while the bay is free:\n${link}` : `Need more time? Sign in, open My bookings and then your pass, and add up to ${maxHours} more hours while the bay is free.`;
  const over = `If you stay past ${until} without adding time, the first ${graceMinutes} minutes are free and after that every started hour costs ${rateText}. You pay it on your pass before you drive out.`;
  const lines = [
    `Hello ${first},`,
    '',
    `Your parking at ${siteName} ends at ${until}, in about ${minutesLeft} minutes.`,
    '',
    `  Vehicle: ${row.vehicleLabel}, ${row.plate}`,
    `  Bay:     ${row.bay} (${row.zone})`,
    `  Ends:    ${until}`,
    '',
    more,
    '',
    over,
  ];
  if (supportEmail) lines.push('', `Questions? Write to ${supportEmail} and quote ${row.ref}.`);
  lines.push('', siteName);
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:34rem">' +
    `<p>Hello ${escapeHtml(first)},</p>` +
    `<p>Your parking at ${escapeHtml(siteName)} ends at <b>${escapeHtml(until)}</b>, in about ${minutesLeft} minutes.</p>` +
    `<p>${escapeHtml(row.vehicleLabel)}, <b>${escapeHtml(row.plate)}</b>, bay ${escapeHtml(row.bay)} (${escapeHtml(row.zone)})</p>` +
    (link
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0b1530;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Open my pass and add time</a></p><p>You can add up to ${maxHours} more hours while the bay is free.</p>`
      : `<p>${escapeHtml(more)}</p>`) +
    `<p>${escapeHtml(over)}</p>` +
    (supportEmail ? `<p>Questions? Write to ${escapeHtml(supportEmail)} and quote ${escapeHtml(row.ref)}.</p>` : '') +
    `<p>${escapeHtml(siteName)}</p></div>`;
  return { subject: `Your parking ends at ${until}`, text: lines.join('\n'), html };
}

module.exports = { createMailer, cancellationEmail, customerCancelEmail, passwordResetEmail, passwordChangedEmail, endingSoonEmail, maskEmail, PROVIDERS };
