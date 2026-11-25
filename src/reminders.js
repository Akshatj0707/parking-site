'use strict';

/*
 * "Your parking ends soon": one email to a parked customer a few minutes before the booked end, with a link to the pass page
 * where more hours can be added. It is sent only when
 *   - the vehicle was scanned in and has not left,
 *   - the booking belongs to an account that has an email address, and
 *   - email sending is set up (src/mail.js).
 * There is no SMS: that needs a paid provider. The reminder goes out once per booked end time (booking.endReminderFor), so a
 * customer who adds time gets a new reminder for the new end. A send that fails is tried again on the next minute, up to
 * three times. server.js calls run() once a minute.
 */

const S = require('./../public/js/shared.js');
const { endingSoonEmail } = require('./mail');

const MIN = 60 * 1000;
const MAX_TRIES = 3;

function createReminders({ config, bookings, gate, auth, mailer, log, now = Date.now }) {
  let running = false;

  // Sends the reminders that are due. Returns how many emails went out.
  async function run() {
    const lead = config.reminder.minutes * MIN;
    if (!lead || !mailer.enabled || running) return 0;
    running = true;
    let sent = 0;
    try {
      const t = now();
      for (const b of bookings.store.bookings) {
        if (b.status !== 'paid' || !b.customerId || !b.entryAt || b.exitScanAt || b.exitAt) continue;
        if (b.endReminderFor === b.endMs || t < b.endMs - lead || t >= b.endMs) continue;
        const user = auth.users.byId(b.customerId);
        if (!user || !user.email) {
          b.endReminderFor = b.endMs; // nobody to write to
          continue;
        }
        if (b.endReminderTriesFor !== b.endMs) {
          b.endReminderTriesFor = b.endMs;
          b.endReminderTries = 0;
        }
        if (b.endReminderTries >= MAX_TRIES) continue;
        b.endReminderTries += 1;
        const info = gate.summary(b);
        const path = gate.passPath(b);
        const content = endingSoonEmail({
          siteName: config.siteName,
          supportEmail: config.supportEmail,
          name: user.name,
          row: bookings.operatorRow(b),
          until: S.formatTime(b.endMs, config.utcOffsetMinutes),
          minutesLeft: Math.max(1, Math.round((b.endMs - t) / MIN)),
          link: config.gate.publicUrl && path ? config.gate.publicUrl + path : '',
          maxHours: config.extend.maxHours,
          graceMinutes: config.gate.graceMinutes,
          rateText: `₹${info.rate} an hour`,
        });
        const result = await mailer.send({ to: user.email, ...content });
        if (result.status === 'sent') {
          b.endReminderFor = b.endMs;
          sent += 1;
        } else {
          log.warn(`The reminder for booking ${b.ref} could not be sent (${result.reason || result.status}).`);
        }
        bookings.persist();
      }
    } finally {
      running = false;
    }
    return sent;
  }

  return { run };
}

module.exports = { createReminders };
