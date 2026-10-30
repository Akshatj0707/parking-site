'use strict';

// Counts hits per key inside a fixed time window. Used to slow down guessing and abuse.
class HitCounter {
  constructor(windowMs, now = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
    const timer = setInterval(() => this.sweep(), windowMs);
    if (timer.unref) timer.unref(); // never keep the program alive just for this
  }

  sweep() {
    const t = this.now();
    for (const [key, entry] of this.entries) if (entry.reset <= t) this.entries.delete(key);
  }

  current(key) {
    const entry = this.entries.get(key);
    return entry && entry.reset > this.now() ? entry : null;
  }

  hit(key) {
    let entry = this.current(key);
    if (!entry) {
      entry = { count: 0, reset: this.now() + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return entry;
  }
}

// Express middleware: allow at most `max` requests per visitor address per window.
function createLimiter({ windowMs, max, message }) {
  const counter = new HitCounter(windowMs);
  return (req, res, next) => {
    const entry = counter.hit(req.ip || 'unknown');
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.reset - Date.now()) / 1000))));
      return res.status(429).json({ error: 'rate_limited', message: message || 'Too many requests. Please wait a minute and try again.' });
    }
    return next();
  };
}

module.exports = { HitCounter, createLimiter };
