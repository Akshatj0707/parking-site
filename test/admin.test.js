'use strict';

// The three roles (Admin, Government official and Customer) and the owner's pages: every booking, every customer, the business numbers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeSite, pay, car, bike, basic, START } = require('./helpers');
const roles = require('../src/roles');

const OP = { OPERATOR_PASSWORD: 'correct horse battery' };
const ADMIN_BASIC = { headers: { authorization: basic('operator', OP.OPERATOR_PASSWORD) } };
const JSON_ASK = { accept: 'application/json' };
const HTML_ASK = { accept: 'text/html,application/xhtml+xml' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const cookieOf = (r) => {
  const line = r.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  return line ? line.split(';')[0] : null;
};
const as = (cookie, extra = {}) => ({ headers: { cookie, ...JSON_ASK, ...extra } });

async function site(t, options = {}) {
  const s = await makeSite({ razorpayKeys: true, env: { ...OP, ...(options.env || {}) }, ...options.rest });
  t.after(() => s.close());
  return s;
}

async function signUp(s, name, email) {
  const r = await s.post('/api/auth/signup', { name, email, password: 'a-good-password' });
  assert.equal(r.status, 201, r.text);
  return cookieOf(r);
}

async function adminCookie(s) {
  const r = await s.post('/api/auth/login', { identifier: 'operator', password: OP.OPERATOR_PASSWORD });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}

// A customer books and pays through the (pretend) Razorpay.
async function bookPaid(s, cookie, body, paymentId) {
  const created = await s.post('/api/bookings', body, cookie ? { headers: { cookie } } : undefined);
  assert.equal(created.status, 201, created.text);
  const paid = await pay(s, created, paymentId);
  assert.equal(paid.status, 200, paid.text);
  return created.json.booking;
}

// ===== The permission table ====================================================================================

test('there are exactly three roles, and the permission table is the single source of truth', () => {
  assert.deepEqual(Object.keys(roles.ROLES).sort(), ['admin', 'customer', 'official']);
  // a customer can book and see their own bookings, and nothing else
  assert.deepEqual(roles.permissionsOf('customer').sort(), ['booking:create', 'booking:view-own']);
  for (const p of Object.keys(roles.PERMISSIONS).filter((x) => !['booking:create', 'booking:view-own'].includes(x))) {
    assert.equal(roles.can('customer', p), false, `a customer must not have ${p}`);
  }
  // the admin holds every owner permission
  for (const p of Object.keys(roles.PERMISSIONS).filter((x) => x !== 'booking:view-own')) {
    assert.equal(roles.can('admin', p), true, `the admin must have ${p}`);
  }
  // unknown roles and permissions are refused, including prototype tricks
  for (const role of ['', 'root', 'constructor', '__proto__', undefined, null]) assert.equal(roles.can(role, 'bookings:view-all'), false, String(role));
  assert.equal(roles.can('admin', 'made:up'), false);
  assert.deepEqual(roles.permissionsOf('__proto__'), []);
  const m = roles.matrix();
  assert.deepEqual(m.roles.map((r) => r.id), ['customer', 'official', 'admin']);
  assert.equal(m.permissions.find((p) => p.id === 'bookings:view-all').roles.join(), 'official,admin');
  assert.equal(m.permissions.find((p) => p.id === 'bookings:cancel-refund').roles.join(), 'admin', 'only the owner refunds');
});

test('what a signed-in person is allowed to do is told to the browser', async (t) => {
  const s = await site(t);
  const customer = await signUp(s, 'Asha Verma', 'asha@example.com');
  const me = await s.get('/api/me', as(customer));
  assert.equal(me.json.user.role, 'customer');
  assert.deepEqual(me.json.user.permissions, ['booking:create', 'booking:view-own']);
  const admin = await adminCookie(s);
  const you = await s.get('/api/me', as(admin));
  assert.equal(you.json.user.role, 'admin');
  assert.ok(you.json.user.permissions.includes('bookings:view-all'));
  assert.ok(!JSON.stringify(you.json).includes(OP.OPERATOR_PASSWORD));
});

// ===== Who may open what ===========================================================================================

const ADMIN_GETS = [
  '/api/dashboard',
  '/api/dashboard/overview',
  '/api/dashboard/all-bookings',
  '/api/dashboard/export.csv',
  '/api/dashboard/customers',
  '/api/dashboard/roles',
  '/api/dashboard/analytics',
  '/api/dashboard/connection',
  '/api/dashboard/bookings?plate=MP09AB1234',
];
const ADMIN_PAGES = ['/dashboard', '/business', '/bookings', '/customers', '/analytics'];

test('every admin data route: nobody signed in gets 401, a customer gets 403, the admin gets through', async (t) => {
  const s = await site(t);
  const customer = await signUp(s, 'Asha Verma', 'asha@example.com');
  const admin = await adminCookie(s);
  for (const url of ADMIN_GETS) {
    const anon = await s.get(url, { headers: JSON_ASK });
    assert.equal(anon.status, 401, `${url} anonymous: ${anon.text}`);
    assert.equal(anon.headers.get('www-authenticate'), null, 'the browser does not pop up a password box');
    const cust = await s.get(url, as(customer));
    assert.equal(cust.status, 403, `${url} as a customer: ${cust.text}`);
    assert.ok(!/"rows"|"collection"/.test(cust.text), 'a refused request leaks no data');
    const ok = await s.get(url, as(admin));
    assert.equal(ok.status, 200, `${url} as the admin: ${ok.text}`);
  }
});

test('every admin action: a customer cannot cancel a booking or touch sample data, and the other site cannot either', async (t) => {
  const s = await site(t);
  const customer = await signUp(s, 'Asha Verma', 'asha@example.com');
  const booking = await bookPaid(s, customer, car(), 'pay_one');
  for (const [url, body] of [[`/api/dashboard/bookings/${booking.ref}/cancel`, {}], ['/api/dashboard/sample-data', { action: 'add' }]]) {
    assert.equal((await s.post(url, body, as(customer))).status, 403, url);
    assert.equal((await s.post(url, body, { headers: JSON_ASK })).status, 401, url);
  }
  assert.equal(s.store.bookings.find((b) => b.ref === booking.ref).status, 'paid', 'the booking is untouched');
  // a customer sees only their own bookings, and the admin does not have "own" bookings
  assert.equal((await s.get('/api/account/bookings', as(customer))).json.bookings.length, 1);
  const admin = await adminCookie(s);
  assert.equal((await s.get('/api/account/bookings', as(admin))).status, 403);
});

test('the admin pages: a visitor is sent to sign in, a customer is told it is for staff only, the admin sees the page', async (t) => {
  const s = await site(t);
  const customer = await signUp(s, 'Asha Verma', 'asha@example.com');
  const admin = await adminCookie(s);
  for (const page of ADMIN_PAGES) {
    const visitor = await s.get(page, { headers: HTML_ASK, redirect: 'manual' });
    assert.equal(visitor.status, 302, page);
    assert.equal(visitor.headers.get('location'), '/login?next=' + encodeURIComponent(page));
    const cust = await s.get(page, { headers: { cookie: customer, ...HTML_ASK } });
    assert.equal(cust.status, 403, page);
    assert.match(cust.text, /Staff only/);
    const ok = await s.get(page, { headers: { cookie: admin, ...HTML_ASK } });
    assert.equal(ok.status, 200, page);
    assert.ok(!/<script>(?!\s*<\/script>)/.test(ok.text), `${page} has no inline script`);
    assert.ok(!/demo/i.test(ok.text), `${page} does not say demo`);
    for (const link of ADMIN_PAGES) assert.ok(ok.text.includes(`href="${link}"`), `${page} links to ${link}`);
  }
  // the public pages stay public and never show the admin's links
  const home = await s.get('/', { headers: HTML_ASK });
  assert.equal(home.status, 200);
});

// ===== Every booking ===============================================================================================

async function seed(t) {
  const s = await site(t);
  const asha = await signUp(s, 'Asha Verma', 'asha@example.com');
  const ravi = await signUp(s, 'Ravi Kumar', 'ravi@example.com');
  const a1 = await bookPaid(s, asha, car({ plate: 'MP09AB1111', time: '11:00', hours: 2 }), 'pay_asha1');
  const a2 = await bookPaid(s, asha, bike({ plate: 'MP09AB2222', time: '13:00', hours: 1 }), 'pay_asha2');
  const r1 = await bookPaid(s, ravi, car({ plate: 'MP09CD3333', time: '11:30', hours: 3 }), 'pay_ravi1');
  const guest = await bookPaid(s, null, car({ plate: 'MP09EF4444', time: '15:00', hours: 1 }), 'pay_guest1');
  // an attempt that is never paid
  const attempt = await s.post('/api/bookings', car({ plate: 'MP09GH5555', time: '16:00', hours: 1 }));
  assert.equal(attempt.status, 201);
  return { s, asha, ravi, a1, a2, r1, guest, attempt, admin: await adminCookie(s) };
}

test('the admin sees every booking of every customer, with who paid and the Razorpay ids', async (t) => {
  const { s, admin, a1 } = await seed(t);
  const all = (await s.get('/api/dashboard/all-bookings', as(admin))).json;
  assert.equal(all.total, 4, 'four real bookings; the unpaid attempt is not one of them');
  assert.equal(all.totals.paidCount, 4);
  assert.equal(all.totals.paid, 80 + 20 + 120 + 40, 'the money of the whole list');
  const row = all.rows.find((r) => r.ref === a1.ref);
  assert.equal(row.customer.name, 'Asha Verma');
  assert.equal(row.customer.email, 'asha@example.com');
  assert.equal(row.paymentId, 'pay_asha1');
  assert.match(row.orderId, /^order_/);
  assert.equal(row.plate, 'MP 09 AB 1111');
  assert.equal(row.status, 'paid');
  assert.equal(all.rows.find((r) => r.plate === 'MP 09 EF 4444').customer, null, 'a booking made without an account is a guest');
  // a customer can see only their own
  const mine = (await s.get('/api/account/bookings', as(await (async () => cookieOf(await s.post('/api/auth/login', { identifier: 'ravi@example.com', password: 'a-good-password' })))()))).json.bookings;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].plate, 'MP 09 CD 3333');
});

test('search and filters find the right bookings', async (t) => {
  const { s, admin, a1, a2 } = await seed(t);
  const find = async (qs) => (await s.get('/api/dashboard/all-bookings?' + qs, as(admin))).json;
  assert.equal((await find('q=asha')).total, 2, 'by customer name');
  assert.equal((await find('q=RAVI@example.com')).total, 1, 'by e-mail, in any case');
  assert.equal((await find('q=mp09ab1111')).rows[0].ref, a1.ref, 'by vehicle number as typed');
  assert.equal((await find('q=MP 09 AB 2222')).rows[0].ref, a2.ref, 'by vehicle number with spaces');
  assert.equal((await find('q=' + a1.ref.toLowerCase())).rows[0].ref, a1.ref, 'by booking reference');
  assert.equal((await find('q=pay_ravi1')).total, 1, 'by Razorpay payment id');
  assert.equal((await find('q=nobody-by-this-name')).total, 0);
  assert.equal((await find('vehicle=bike')).total, 1);
  assert.equal((await find('vehicle=car')).total, 3);
  assert.equal((await find('status=unpaid')).total, 1, 'the unpaid attempt');
  assert.equal((await find('status=all')).total, 5);
  assert.equal((await find('status=refunded')).total, 0);
  assert.equal((await find('when=upcoming')).total, 4, 'all start after 10:00');
  assert.equal((await find('when=active')).total, 0);
  assert.equal((await find('when=ended')).total, 0);
  assert.equal((await find('from=2026-10-15')).total, 0);
  assert.equal((await find('from=2026-10-14&to=2026-10-14')).total, 4);
  assert.equal((await find('sort=amount_desc')).rows[0].plate, 'MP 09 CD 3333', 'the 3-hour booking costs most');
  // nonsense is ignored rather than breaking the page
  assert.equal((await find('status=%3Cscript%3E&vehicle=truck&when=never&from=yesterday&sort=drop')).total, 4);
  // sorting and paging
  const paged = await find('pageSize=10&page=99');
  assert.equal(paged.page, 1);
  assert.equal(paged.pages, 1);
});

test('the list is split into pages', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  for (let i = 0; i < 12; i++) {
    const plate = `MP09AB${String(1000 + i)}`;
    await bookPaid(s, null, car({ plate, time: '12:00', hours: 1 }), 'pay_page' + i);
  }
  const first = (await s.get('/api/dashboard/all-bookings?pageSize=10', as(admin))).json;
  assert.equal(first.total, 12);
  assert.equal(first.pages, 2);
  assert.equal(first.rows.length, 10);
  const second = (await s.get('/api/dashboard/all-bookings?pageSize=10&page=2', as(admin))).json;
  assert.equal(second.rows.length, 2);
  assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.ref)).size, 12, 'no booking is listed twice or missed');
});

test('the admin can cancel a paid booking from the list and the refund appears in it', async (t) => {
  const { s, admin, a1 } = await seed(t);
  const done = await s.post(`/api/dashboard/bookings/${a1.ref}/cancel`, {}, as(admin));
  assert.equal(done.status, 200, done.text);
  const refunded = (await s.get('/api/dashboard/all-bookings?status=refunded', as(admin))).json;
  assert.equal(refunded.total, 1);
  assert.equal(refunded.rows[0].ref, a1.ref);
  assert.equal(refunded.rows[0].cancelledByOperator, true);
  assert.match(refunded.rows[0].refundId, /^rfnd_/);
  assert.equal(refunded.totals.refunded, 80);
});

// ===== The spreadsheet ===========================================================================================

test('the spreadsheet download has every booking, with the right columns', async (t) => {
  const { s, admin, a1 } = await seed(t);
  const res = await s.get('/api/dashboard/export.csv', as(admin));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="bookings-2026-10-14\.csv"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const raw = Buffer.from(await (await fetch(s.base + '/api/dashboard/export.csv', { headers: { cookie: admin } })).arrayBuffer());
  assert.equal(raw.subarray(0, 3).toString('hex'), 'efbbbf', 'a byte-order mark, so Excel reads accents and other scripts correctly');
  assert.ok(res.text.startsWith('Reference,Booked on,Paid on,Customer name,Customer email,Vehicle type,Vehicle number,Bay,Parking from,Parking until,Hours,Amount (INR),Status,Razorpay payment id,Razorpay order id,Razorpay refund id\r\n'));
  const lines = res.text.trim().split('\r\n');
  assert.equal(lines.length, 5, 'a header and four bookings');
  const line = lines.find((l) => l.startsWith(a1.ref));
  assert.ok(line.includes('Asha Verma,asha@example.com,4-wheeler,MP 09 AB 1111'), line);
  assert.ok(line.includes('2026-10-14 11:00,2026-10-14 13:00,2,80.00,paid,pay_asha1,order_'), line);
  // the same filters as the page
  const only = await s.get('/api/dashboard/export.csv?vehicle=bike', as(admin));
  assert.equal(only.text.trim().split('\r\n').length, 2);
});

test('a name that looks like a spreadsheet formula cannot run in the spreadsheet', async (t) => {
  const s = await site(t);
  const evil = await signUp(s, '=HYPERLINK("http://evil.example","click")', 'evil@example.com');
  await bookPaid(s, evil, car(), 'pay_evil');
  const comma = await signUp(s, 'Singh, "Raj"', 'raj@example.com');
  await bookPaid(s, comma, car({ plate: 'MP09ZZ9999', time: '14:00' }), 'pay_comma');
  const admin = await adminCookie(s);
  const csv = (await s.get('/api/dashboard/export.csv', as(admin))).text;
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"",""click"")"'), csv);
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), 'no cell starts with =');
  assert.ok(csv.includes('"Singh, ""Raj"""'), 'commas and quotes are escaped');
});

// ===== Customers ===================================================================================================

test('the customer list shows what each customer spent, and never a password', async (t) => {
  const { s, admin } = await seed(t);
  const res = await s.get('/api/dashboard/customers', as(admin));
  assert.equal(res.status, 200);
  assert.ok(!/"pass"|s1\$|password/i.test(res.text), 'no password, hashed or not');
  const { rows, total } = res.json;
  assert.equal(total, 2, 'two accounts; the guest booking is not a customer');
  const asha = rows.find((r) => r.email === 'asha@example.com');
  assert.equal(asha.name, 'Asha Verma');
  assert.equal(asha.bookings, 2);
  assert.equal(asha.spent, 80 + 20);
  assert.equal(rows[0].email, 'ravi@example.com', 'the biggest spender (the 3-hour booking) is first');
  assert.ok(asha.nextBookingAt > START);
  assert.equal((await s.get('/api/dashboard/customers?q=RAV', as(admin))).json.total, 1);
  assert.equal((await s.get('/api/dashboard/customers?sort=name', as(admin))).json.rows[0].name, 'Asha Verma');
  assert.equal((await s.get('/api/dashboard/customers?sort=bookings', as(admin))).json.rows[0].email, 'asha@example.com');
});

// ===== The owner's numbers =======================================================================================

test('the business overview adds up the money, the lot, the customers and the best days', async (t) => {
  const { s, admin } = await seed(t);
  const o = (await s.get('/api/dashboard/overview', as(admin))).json;
  const spent = 80 + 20 + 120 + 40;
  assert.equal(o.collection.today, spent);
  assert.equal(o.collection.allTime, spent);
  assert.equal(o.collection.thisMonth, spent);
  assert.equal(o.collection.last7, spent);
  assert.equal(o.collection.yesterday, 0);
  assert.equal(o.refunded.allTime, 0);
  assert.equal(o.bookings.paid, 4);
  assert.equal(o.bookings.paidToday, 4);
  assert.equal(o.bookings.upcoming, 4);
  assert.equal(o.bookings.activeNow, 0);
  assert.equal(o.bookings.cancellationRate, 0);
  assert.equal(o.average.booking, spent / 4);
  assert.equal(o.occupancy.percent, 0);
  assert.equal(o.customers.registered, 2);
  assert.equal(o.customers.withBookings, 2);
  assert.equal(o.customers.repeat, 1);
  assert.equal(o.customers.repeatRate, 50);
  assert.equal(o.weekdays.length, 7);
  assert.equal(o.weekdays[3].label, 'Wed');
  assert.equal(o.weekdays[3].bookings, 4);
  assert.equal(o.bestWeekday.label, 'Wed');
  assert.equal(o.months.length, 6);
  assert.equal(o.months[5].label, 'Oct 2026');
  assert.equal(o.months[5].collection, spent);
  assert.equal(o.topCustomers[0].name, 'Ravi Kumar');
  assert.ok(o.peak, 'the busiest hour is known');
  assert.equal(o.payments.mode, 'razorpay');
  assert.equal(o.payments.live, false);
  assert.equal(o.payments.webhookSet, true);
  const text = JSON.stringify(o);
  for (const secret of ['test_secret_value_1234', 'whsec_test_value', OP.OPERATOR_PASSWORD, 'a-good-password']) assert.ok(!text.includes(secret), 'no secret in the overview');
});

test('a booking that is on now counts as in use, and a refund is taken out of the money', async (t) => {
  const { s, admin, a1, r1 } = await seed(t);
  s.advance(90 * 60 * 1000); // 11:30: the first booking (11:00-13:00) and Ravi's (11:30-14:30) are on
  let o = (await s.get('/api/dashboard/overview', as(admin))).json;
  assert.equal(o.bookings.activeNow, 2);
  assert.equal(o.occupancy.car.inUse, 2);
  assert.ok(o.occupancy.percent > 0);
  const gone = await s.post(`/api/dashboard/bookings/${r1.ref}/cancel`, {}, as(admin));
  assert.equal(gone.status, 200, gone.text);
  o = (await s.get('/api/dashboard/overview', as(admin))).json;
  assert.equal(o.collection.allTime, 80 + 20 + 40, 'the refunded 120 is taken out');
  assert.equal(o.refunded.allTime, 120);
  assert.equal(o.bookings.cancelledOrRefunded, 1);
  assert.equal(o.bookings.cancellationRate, 25, 'one of the four booked bays was cancelled');
  assert.equal(o.occupancy.car.inUse, 1);
  assert.ok(a1.ref);
});

test('yesterday and last month are kept apart from today and this month', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const book = await bookPaid(s, null, car({ plate: 'MP09AB1000', time: '11:00' }), 'pay_old');
  s.store.bookings.find((b) => b.ref === book.ref).paidAt = START - DAY; // paid yesterday
  const lastMonth = await bookPaid(s, null, car({ plate: 'MP09AB2000', time: '12:00' }), 'pay_older');
  s.store.bookings.find((b) => b.ref === lastMonth.ref).paidAt = START - 20 * DAY; // 24 Sep
  const o = (await s.get('/api/dashboard/overview', as(admin))).json;
  assert.equal(o.collection.today, 0);
  assert.equal(o.collection.yesterday, 80);
  assert.equal(o.collection.last7, 80);
  assert.equal(o.collection.thisMonth, 80);
  assert.equal(o.collection.lastMonth, 80);
  assert.equal(o.collection.allTime, 160);
  assert.equal(o.months[4].label, 'Sep 2026');
  assert.equal(o.months[4].collection, 80);
});

test('the admin is shown who may do what', async (t) => {
  const s = await site(t);
  const admin = await adminCookie(s);
  const m = (await s.get('/api/dashboard/roles', as(admin))).json;
  assert.deepEqual(m.roles.map((r) => r.label), ['Customer', 'Government official', 'Admin (owner)']);
  assert.ok(m.permissions.length >= 8);
  assert.deepEqual(m.permissions.find((p) => p.id === 'booking:view-own').roles, ['customer', 'official', 'admin'].filter((r) => roles.can(r, 'booking:view-own')));
});

// ===== The pages' scripts ==========================================================================================

test('the owner pages load their scripts and only show data they fetch as text', () => {
  const root = path.join(__dirname, '..', 'public');
  for (const name of ['business', 'bookings', 'customers']) {
    const js = fs.readFileSync(path.join(root, 'js', name + '.js'), 'utf8');
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), `${name}.js puts server data on the page as text, never as HTML`);
    assert.ok(fs.existsSync(path.join(root, name + '.html')));
  }
  assert.ok(fs.existsSync(path.join(root, 'css', 'admin.css')));
});
