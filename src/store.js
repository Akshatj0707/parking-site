'use strict';

const fs = require('fs');
const path = require('path');

// Keeps every booking in memory and in one JSON file (data/bookings.json).
// Writes are synchronous and the file is replaced in one step, so a crash cannot leave half a file.
// This suits one server process and a small lot.
//
// With a `sync` (see docsync.js) the bookings live in the database instead: they are loaded when the site starts, and
// save() passes every change on to the database in the background. No file is read or written then.
class Store {
  constructor(dir, { sync = null } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'bookings.json');
    this.sync = sync;
    this.bookings = [];
    if (sync) {
      this.bookings = sync.initial;
      sync.list = () => this.bookings;
      sync.adopted = (doc) => {
        if (!this.bookings.some((b) => b.id === doc.id)) this.bookings.push(doc);
      };
    } else {
      this.load();
    }
  }

  // The database's complaint when it is not accepting changes, otherwise null. Always null for files.
  get syncError() {
    return this.sync ? this.sync.errorText : null;
  }

  // Resolves when the database holds every change so far (at once for files). Rejects if the database refuses.
  settled() {
    return this.sync ? this.sync.settled() : Promise.resolve();
  }

  // As settled(), but never rejects and never waits longer than `ms`: true if everything is saved.
  settledWithin(ms) {
    return this.sync ? this.sync.settledWithin(ms) : Promise.resolve(true);
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.bookings = Array.isArray(data.bookings) ? data.bookings : [];
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`bookings.json could not be read. It was moved to ${backup} and the site started with an empty list.`);
      this.bookings = [];
    }
  }

  save() {
    if (this.sync) {
      this.sync.schedule();
      return;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, bookings: this.bookings }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  add(booking) {
    this.bookings.push(booking);
  }

  get(id) {
    return this.bookings.find((b) => b.id === id) || null;
  }

  byOrderId(orderId) {
    return this.bookings.find((b) => b.orderId === orderId) || null;
  }

  remove(id) {
    this.bookings = this.bookings.filter((b) => b.id !== id);
  }

  // Drop unfinished holds and cancelled bookings that are over a day old. Paid and refunded bookings are kept.
  purge(now) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const before = this.bookings.length;
    this.bookings = this.bookings.filter((b) => !((b.status === 'pending' || b.status === 'cancelled') && b.createdAt < cutoff));
    if (this.bookings.length !== before) this.save();
  }
}

module.exports = { Store };
