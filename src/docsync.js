'use strict';

/*
 * Keeps one list of records (all the bookings, or all the customer accounts) in step with the database.
 *
 * The site works on the list in memory, exactly as it does with files, and calls save() after every change. Here save()
 * hands the change to the database in the background: only the records that changed are written, one write at a time,
 * and a record that was removed is deleted. Nothing in the booking code has to wait for the database, except the few
 * moments where money is involved (it calls settled() there, see bookings.js).
 *
 * If the database cannot be reached, the change stays in memory, the problem is logged and shown on the dashboard, and
 * the write is tried again with growing pauses until it works.
 */

const RETRY_MS = [2000, 5000, 15000, 30000];
const LOG_AGAIN_MS = 60 * 1000;

class DocSync {
  constructor({ db, kind, log = console, now = Date.now, retryMs = RETRY_MS }) {
    this.db = db;
    this.kind = kind;
    this.log = log;
    this.now = now;
    this.retryMs = retryMs;
    this.initial = [];
    this.list = () => [];
    this.adopted = () => {};
    this.written = new Map(); // id -> the JSON text the database holds
    this.running = null;
    this.again = false;
    this.timer = null;
    this.error = null;
    this.attempts = 0;
    this.closed = false;
    this.lastLog = { text: '', at: 0 };
  }

  // The records found in the database when the site started.
  prime(docs) {
    this.initial = docs;
    this.written = new Map(docs.map((d) => [d.id, JSON.stringify(d)]));
  }

  get errorText() {
    return this.error ? String(this.error.message || this.error).slice(0, 200) : null;
  }

  schedule() {
    this.flush().catch(() => {}); // failures are logged and retried inside flush()
  }

  // Resolves once everything changed so far is in the database. Rejects if the database refuses.
  settled() {
    return this.flush();
  }

  // Like settled(), but never rejects and never waits longer than `ms`. True when the database has everything.
  async settledWithin(ms) {
    let timer;
    try {
      await Promise.race([
        this.flush(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ms);
          if (timer.unref) timer.unref();
        }),
      ]);
      return true;
    } catch (err) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  flush() {
    if (this.running) {
      this.again = true; // changed again while a write is under way: write once more afterwards
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.writeChanges();
        } while (this.again);
        this.recovered();
      } catch (err) {
        this.failed(err);
        throw err;
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  async writeChanges() {
    const upserts = [];
    const seen = new Set();
    for (const item of this.list()) {
      seen.add(item.id);
      const json = JSON.stringify(item);
      if (this.written.get(item.id) !== json) upserts.push({ id: item.id, json });
    }
    const deletes = [];
    for (const id of this.written.keys()) if (!seen.has(id)) deletes.push(id);

    if (!upserts.length && !deletes.length) {
      if (this.error) await this.db.ping(); // nothing to write: after a failure, make sure the database really is back
      return;
    }
    await this.db.apply(this.kind, upserts, deletes);
    for (const u of upserts) this.written.set(u.id, u.json);
    for (const id of deletes) this.written.delete(id);
  }

  failed(err) {
    this.error = err;
    this.attempts += 1;
    const text = String((err && err.message) || err);
    const now = this.now();
    if (text !== this.lastLog.text || now - this.lastLog.at > LOG_AGAIN_MS) {
      this.lastLog = { text, at: now };
      this.log.error(`COULD NOT SAVE the ${this.kind} records to the database: ${text}. They are kept in memory and the save is tried again. Do not restart the site until this clears.`);
    }
    if (this.closed || this.timer) return;
    const delay = this.retryMs[Math.min(this.attempts - 1, this.retryMs.length - 1)];
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  recovered() {
    if (this.error) this.log.info(`The database accepts ${this.kind} changes again.`);
    this.error = null;
    this.attempts = 0;
  }

  // Another copy of the site may have saved records while this one was running (for a few seconds during an update both
  // run). Take in records that are in the database but unknown here. Records already known are never touched.
  async adopt() {
    const known = new Set(this.list().map((item) => item.id));
    const ids = await this.db.ids(this.kind);
    const unknown = ids.filter((id) => !known.has(id) && !this.written.has(id));
    if (!unknown.length) return 0;
    const docs = await this.db.docs(this.kind, unknown);
    let taken = 0;
    for (const doc of docs) {
      if (!doc || typeof doc.id !== 'string' || known.has(doc.id)) continue;
      this.written.set(doc.id, JSON.stringify(doc));
      this.adopted(doc);
      taken += 1;
    }
    return taken;
  }

  async close(waitMs = 8000) {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    return this.settledWithin(waitMs);
  }
}

module.exports = { DocSync };
