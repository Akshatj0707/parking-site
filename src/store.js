'use strict';

const fs = require('fs');
const path = require('path');

// Keeps every booking in memory and in one JSON file (data/bookings.json).
// Writes are synchronous and the file is replaced in one step, so a crash cannot leave half a file.
// This suits one server process and a small lot. For several servers or heavy traffic, use a real database.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'bookings.json');
    this.bookings = [];
    this.load();
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
