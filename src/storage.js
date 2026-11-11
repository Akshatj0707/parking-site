'use strict';

/*
 * Opens the place where bookings and customer accounts are kept, once, when the site starts.
 *
 *   files      (default)   data/bookings.json and data/users.json (on Render: the disk). Everything works as before.
 *   database   DATABASE_URL is set   a Postgres database. Everything is loaded before the first customer is served, and
 *              every change is written to it straight away (see docsync.js).
 *
 * With a database the site never starts "empty" by mistake: if the database cannot be reached it waits a little, and
 * then stops with a clear message. An empty list would let a bay that is already paid for be sold a second time.
 */

const crypto = require('crypto');
const { Store } = require('./store');
const { UserStore } = require('./auth');
const { DocSync } = require('./docsync');
const { Database } = require('./database');

const CONNECT_TRIES = 6;
const CONNECT_WAIT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openStorage(config, { log = console, database = null, wait = sleep } = {}) {
  if (!config.database.enabled) {
    return {
      kind: 'files',
      store: new Store(config.dataDir),
      users: new UserStore(config.dataDir),
      sessionKey: null,
      adopt: async () => 0,
      close: async () => {},
    };
  }
  if (!config.database.valid) {
    throw new Error('DATABASE_URL is not a Postgres address. It should look like postgresql://user:password@host/dbname.');
  }

  const ownsDb = !database; // a database handed in by the caller (the tests) is closed by the caller
  const db = database || Database.connect(config.database.url, { log });
  const bookingKind = `${config.database.scope}:booking`;
  const userKind = `${config.database.scope}:user`;

  // Free databases go to sleep when idle and need a few seconds to wake, so give them a few tries.
  let bookings;
  let users;
  let sessionKey = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.init();
      bookings = await db.load(bookingKind);
      users = await db.load(userKind);
      if (!config.auth.sessionSecret) sessionKey = await db.sessionKey(crypto.randomBytes(48));
      break;
    } catch (err) {
      if (attempt >= CONNECT_TRIES) {
        throw new Error(`The database at ${config.database.host} could not be reached: ${err.message}. Check DATABASE_URL under Environment in Render.`);
      }
      log.warn(`Waiting for the database at ${config.database.host} (${attempt}/${CONNECT_TRIES}): ${err.message}`);
      await wait(CONNECT_WAIT_MS);
    }
  }

  const bookingSync = new DocSync({ db, kind: bookingKind, log });
  bookingSync.prime(bookings);
  const userSync = new DocSync({ db, kind: userKind, log });
  userSync.prime(users);

  return {
    kind: 'database',
    db,
    store: new Store(config.dataDir, { sync: bookingSync }),
    users: new UserStore(config.dataDir, { sync: userSync }),
    sessionKey,
    // Take in records another copy of the site saved while this one was running (see DocSync.adopt).
    async adopt() {
      return (await bookingSync.adopt()) + (await userSync.adopt());
    },
    // Called when the site stops: let the database take the last changes first.
    async close() {
      await Promise.all([bookingSync.close(), userSync.close()]);
      if (!ownsDb) return;
      try {
        await db.close();
      } catch (err) {
        // already closed
      }
    },
  };
}

module.exports = { openStorage };
