'use strict';

/*
 * Accounts and roles.
 *
 * There are two roles:
 *   ADMIN     the lot operator. Signs in with the operator user name and OPERATOR_PASSWORD (there is no admin row in
 *             users.json, so nobody can become an admin by signing up). May use the dashboard, the analytics page,
 *             cancel and refund bookings.
 *   CUSTOMER  anyone who signs up with a name, an email and a password. May book a bay and see their own bookings.
 *             A customer can never open the operator pages.
 *
 * A sign-in is a signed cookie (HttpOnly, SameSite=Lax, Secure on https). Passwords are kept only as scrypt hashes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { HttpError } = require('./errors');
const { HitCounter } = require('./ratelimit');
const { permissionsOf } = require('./roles');

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'bf_session';
const CUSTOMER_SECONDS = 14 * 24 * 3600;
const ADMIN_SECONDS = 12 * 3600;
const MAX_USERS = 20000;
const USER_ID = /^usr_[0-9a-f]{12}$/;
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', '11111111', 'abcd1234', 'iloveyou', 'admin123', 'letmein1', 'welcome1']);

// A public test site (payments simulated) creates this customer for itself, so a visitor can sign in at once.
// It is never created once Razorpay keys are set.
const TEST_CUSTOMER = { name: 'Test Customer', email: 'customer@example.com', password: 'Customer@123' };

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString('base64url')}$${crypto.scryptSync(password, salt, 32).toString('base64url')}`;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `s1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1], 'base64url');
  const want = Buffer.from(parts[2], 'base64url');
  if (!salt.length || want.length !== 32) return false;
  const got = await scrypt(password, salt, 32);
  return crypto.timingSafeEqual(got, want);
}

function normalizeEmail(value) {
  const email = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (email.length > 120 || !/^[^\s@<>]{1,64}@[^\s@<>]{1,100}\.[^\s@<>]{2,}$/.test(email)) return null;
  return email;
}

// Customer accounts, kept in users.json next to bookings.json (written in one step, like the bookings).
class UserStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'users.json');
    this.users = [];
    this.load();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      return; // no accounts yet
    }
    try {
      const data = JSON.parse(text);
      this.users = Array.isArray(data.users) ? data.users : [];
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
      } catch (moveErr) {
        // leave it where it is
      }
      console.error(`users.json could not be read. It was moved to ${backup} and the site started with no customer accounts.`);
      this.users = [];
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  byId(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  byEmail(email) {
    return this.users.find((u) => u.email === email) || null;
  }

  add(user) {
    this.users.push(user);
  }
}

// The key that signs the cookies. SESSION_SECRET if it is set; otherwise a random key kept next to the bookings (so
// sign-ins survive a restart wherever the bookings do); otherwise a random key for as long as the server runs.
function loadSecret(config) {
  if (config.auth.sessionSecret) return Buffer.from(config.auth.sessionSecret, 'utf8');
  const file = path.join(config.dataDir, 'session.key');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch (err) {
    // not created yet
  }
  const fresh = crypto.randomBytes(48);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, fresh, { mode: 0o600 });
  } catch (err) {
    // a folder that cannot be written: sign-ins then last until the next restart
  }
  return fresh;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function createAuth({ config, now = Date.now, log = console }) {
  const users = new UserStore(config.dataDir);
  const secret = loadSecret(config);
  const sign = (text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');
  // Changing OPERATOR_PASSWORD signs every admin out: the cookie carries a fingerprint of the password it was made with.
  const passwordMark = () => crypto.createHmac('sha256', secret).update('pw|' + config.operator.password).digest('base64url').slice(0, 10);
  const failures = new HitCounter(15 * 60 * 1000, now);
  let dummy = null; // a hash to check against when the email is unknown, so unknown and known emails take equally long

  const publicUser = (s) => (s ? { role: s.role, name: s.name, email: s.email || null, permissions: permissionsOf(s.role) } : null);

  function cookieFlags(req, maxAge) {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
  }

  function start(req, res, session) {
    const seconds = session.role === 'admin' ? ADMIN_SECONDS : CUSTOMER_SECONDS;
    const payload = Buffer.from(JSON.stringify({ r: session.role, u: session.id || null, e: now() + seconds * 1000, p: session.role === 'admin' ? passwordMark() : null })).toString('base64url');
    res.append('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; ${cookieFlags(req, seconds)}`);
    req.bfSession = session;
    return session;
  }

  function end(req, res) {
    res.append('Set-Cookie', `${COOKIE}=; ${cookieFlags(req, 0)}`);
    req.bfSession = null;
  }

  // Who is making this request: { role: 'admin' | 'customer', id, name, email } or null.
  function current(req) {
    if (req.bfSession !== undefined) return req.bfSession;
    req.bfSession = null;
    const token = readCookie(req, COOKIE);
    if (!token || token.length > 600) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(sign(payload));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (err) {
      return null;
    }
    if (!data || typeof data.e !== 'number' || data.e <= now()) return null;
    if (data.r === 'admin') {
      if (!config.operator.password || data.p !== passwordMark()) return null;
      req.bfSession = { role: 'admin', id: null, name: config.operator.user, email: null };
    } else if (data.r === 'customer') {
      const user = typeof data.u === 'string' ? users.byId(data.u) : null;
      if (!user) return null;
      req.bfSession = { role: 'customer', id: user.id, name: user.name, email: user.email };
    }
    return req.bfSession;
  }

  function tooMany(res, seconds) {
    res.set('Retry-After', String(seconds));
    return new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Please wait a few minutes and try again.');
  }

  async function signup(body, req, res) {
    const b = body && typeof body === 'object' ? body : {};
    const name = String(b.name === undefined || b.name === null ? '' : b.name).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60 || /[\u0000-\u001f<>]/.test(name)) throw new HttpError(400, 'invalid_name', 'Enter your name (up to 60 characters, no < or >).');
    const email = normalizeEmail(b.email);
    if (!email) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8 || password.length > 100 || COMMON_PASSWORDS.has(password.toLowerCase()) || password.toLowerCase() === email) {
      throw new HttpError(400, 'weak_password', 'Use a password of 8 to 100 characters that is not a very common one.');
    }
    if (users.users.length >= MAX_USERS) throw new HttpError(503, 'accounts_full', 'New accounts cannot be created right now.');
    if (users.byEmail(email)) throw new HttpError(409, 'email_taken', 'An account with that email already exists. Sign in instead.');
    const pass = await hashPassword(password);
    if (users.byEmail(email)) throw new HttpError(409, 'email_taken', 'An account with that email already exists. Sign in instead.');
    const user = { id: 'usr_' + crypto.randomBytes(6).toString('hex'), role: 'customer', name, email, pass, createdAt: now() };
    users.add(user);
    try {
      users.save();
    } catch (err) {
      log.error(`COULD NOT SAVE customer accounts: ${err.message}. The account works until the server restarts.`);
    }
    return start(req, res, { role: 'customer', id: user.id, name: user.name, email: user.email });
  }

  async function login(body, req, res) {
    const b = body && typeof body === 'object' ? body : {};
    const identifier = String(b.identifier === undefined || b.identifier === null ? '' : b.identifier).trim().toLowerCase().slice(0, 120);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!identifier || !password || password.length > 200) throw new HttpError(400, 'missing_fields', 'Enter your email and password.');

    const ipKey = 'ip|' + (req.ip || 'unknown');
    const isOperator = Boolean(config.operator.password) && identifier === config.operator.user.toLowerCase();
    // The operator is limited per connection only, so that nobody can lock the operator out by guessing.
    const accountKey = isOperator ? null : 'acct|' + identifier;
    const ipFails = failures.current(ipKey);
    const accountFails = accountKey ? failures.current(accountKey) : null;
    if ((ipFails && ipFails.count >= 20) || (accountFails && accountFails.count >= 10)) throw tooMany(res, 300);

    let session = null;
    if (isOperator) {
      if (sameSecret(password, config.operator.password)) session = { role: 'admin', id: null, name: config.operator.user, email: null };
    } else {
      const user = users.byEmail(identifier);
      if (!user && !dummy) dummy = hashPassword('a password nobody has');
      const ok = await checkPassword(password, user ? user.pass : await dummy);
      if (user && ok) session = { role: 'customer', id: user.id, name: user.name, email: user.email };
    }
    if (!session) {
      failures.hit(ipKey);
      if (accountKey) failures.hit(accountKey);
      throw new HttpError(401, 'bad_login', 'That email or password is not right.');
    }
    return start(req, res, session);
  }

  function seedTestCustomer() {
    if (users.byEmail(TEST_CUSTOMER.email)) return;
    users.add({ id: 'usr_' + crypto.randomBytes(6).toString('hex'), role: 'customer', name: TEST_CUSTOMER.name, email: TEST_CUSTOMER.email, pass: hashPasswordSync(TEST_CUSTOMER.password), createdAt: now() });
    try {
      users.save();
    } catch (err) {
      log.error(`COULD NOT SAVE customer accounts: ${err.message}.`);
    }
  }

  if (config.auth.seedTestCustomer) seedTestCustomer();

  return { users, current, publicUser, signup, login, logout: end, TEST_CUSTOMER, USER_ID };
}

module.exports = { createAuth, UserStore, hashPassword, checkPassword, normalizeEmail, TEST_CUSTOMER, USER_ID, COOKIE };
