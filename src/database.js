'use strict';

/*
 * The optional database (any Postgres: Neon, Supabase, Render Postgres, your own). Used when DATABASE_URL is set.
 *
 * One table holds every record as a JSON document:  kind ("live:booking", "test:user", ...)  +  id  +  the document.
 * "test" and "live" are kept apart, exactly like the test and live folders on a Render disk, so test bookings can never
 * block a bay once real payments start.
 */

const TABLE = 'bayfind_docs';
const CHUNK = 200;

class Database {
  constructor(pool, { log = console } = {}) {
    this.pool = pool;
    this.log = log;
  }

  static connect(url, { log = console } = {}) {
    const { Pool } = require('pg');
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch (err) {
      // the settings check has already refused an unreadable address
    }
    const local = host === '' || /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(host) || host.startsWith('/');
    const options = {
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 10 * 1000, // free databases go to sleep after a few minutes, so do not keep idle connections
      connectionTimeoutMillis: 10 * 1000,
      query_timeout: 20 * 1000,
      keepAlive: true,
    };
    // Hosted databases insist on an encrypted connection. Their addresses normally say sslmode=require; if not, use it.
    if (!local && !/[?&](sslmode|ssl)=/i.test(url)) options.ssl = { rejectUnauthorized: true };
    const pool = new Pool(options);
    pool.on('error', (err) => log.error(`Database connection problem: ${err.message}`));
    return new Database(pool, { log });
  }

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      kind text NOT NULL,
      id text NOT NULL,
      doc jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, id)
    )`);
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  // Every document of one kind, oldest first (the order the bookings were made in).
  async load(kind) {
    const { rows } = await this.pool.query(
      `SELECT doc FROM ${TABLE} WHERE kind = $1
       ORDER BY CASE WHEN jsonb_typeof(doc->'createdAt') = 'number' THEN (doc->>'createdAt')::numeric END NULLS LAST, id`,
      [kind]
    );
    return rows.map((r) => r.doc).filter((d) => d && typeof d === 'object' && typeof d.id === 'string');
  }

  async ids(kind) {
    const { rows } = await this.pool.query(`SELECT id FROM ${TABLE} WHERE kind = $1`, [kind]);
    return rows.map((r) => r.id);
  }

  async docs(kind, ids) {
    const { rows } = await this.pool.query(`SELECT doc FROM ${TABLE} WHERE kind = $1 AND id = ANY($2::text[])`, [kind, ids]);
    return rows.map((r) => r.doc);
  }

  // Writes the changed documents and deletes the removed ones, all or nothing.
  async apply(kind, upserts, deletes) {
    const client = await this.pool.connect();
    let failure;
    try {
      await client.query('BEGIN');
      for (let i = 0; i < upserts.length; i += CHUNK) {
        const part = upserts.slice(i, i + CHUNK);
        await client.query(
          `INSERT INTO ${TABLE} (kind, id, doc)
           SELECT $1, x.id, x.doc::jsonb FROM unnest($2::text[], $3::text[]) AS x(id, doc)
           ON CONFLICT (kind, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
          [kind, part.map((u) => u.id), part.map((u) => u.json)]
        );
      }
      for (let i = 0; i < deletes.length; i += CHUNK) {
        await client.query(`DELETE FROM ${TABLE} WHERE kind = $1 AND id = ANY($2::text[])`, [kind, deletes.slice(i, i + CHUNK)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      failure = err;
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // the connection is gone; releasing it with the error discards it
      }
      throw err;
    } finally {
      client.release(failure);
    }
  }

  // The key that signs sign-in cookies. Created once and kept here, so customers stay signed in across restarts. If two
  // copies of the site start together, the first one to write wins and both then read the same key.
  async sessionKey(candidate) {
    await this.pool.query(
      `INSERT INTO ${TABLE} (kind, id, doc) VALUES ('meta', 'session-key', $1::jsonb) ON CONFLICT (kind, id) DO NOTHING`,
      [JSON.stringify({ id: 'session-key', key: candidate.toString('base64') })]
    );
    const { rows } = await this.pool.query(`SELECT doc FROM ${TABLE} WHERE kind = 'meta' AND id = 'session-key'`);
    const key = rows[0] && rows[0].doc && rows[0].doc.key;
    return typeof key === 'string' && key.length >= 32 ? Buffer.from(key, 'base64') : candidate;
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { Database, TABLE };
