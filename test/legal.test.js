'use strict';

// The pages that Razorpay looks for before it switches a shop to live payments: pricing, terms of use, privacy,
// cancellation and refunds, shipping and delivery, and contact. And the footer links on every page that lead to them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeSite } = require('./helpers');
const { loadConfig } = require('../src/config');

const PUBLIC = path.join(__dirname, '..', 'public');
const POLICY = {
  '/pricing': 'Pricing',
  '/terms': 'Terms of use',
  '/privacy': 'Privacy policy',
  '/refunds': 'Cancellation and refund policy',
  '/shipping': 'Shipping and delivery',
  '/contact': 'Contact us',
};
// The words on the footer links, in the order they appear.
const FOOTER_LINKS = {
  '/pricing': 'Pricing',
  '/terms': 'Terms',
  '/privacy': 'Privacy',
  '/refunds': 'Cancellation and refunds',
  '/shipping': 'Shipping and delivery',
  '/contact': 'Contact',
};
const OTHER_PAGES = ['/', '/book', '/lookup', '/dashboard'];

const footerOf = (html) => (/<footer[\s\S]*?<\/footer>/.exec(html) || [''])[0];
const hrefsIn = (html) => [...html.matchAll(/href="(\/[^"#?]*)(?:[#?][^"]*)?"/g)].map((m) => m[1]);

test('each policy page is served as HTML, with its title, the site name and nothing left unfilled', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const [url, title] of Object.entries(POLICY)) {
    const res = await site.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /^text\/html/, url);
    assert.equal(res.headers.get('cache-control'), 'no-cache', url);
    assert.doesNotMatch(res.text, /\{\{[A-Z_]+\}\}/, `${url} still has an unfilled {{TOKEN}}`);
    assert.ok(res.text.includes(`<title>${title} · Bayfind</title>`), `${url} has "${title}" and the site name in its title`);
    assert.equal([...res.text.matchAll(/<h1[ >]/g)].length, 1, `${url} has exactly one main heading`);
    assert.ok(res.text.includes(`<h1 class="h1">${title}</h1>`), `${url} shows its title as the heading`);
    assert.match(res.text, /<meta name="description" content="[^"]{20,}">/, `${url} has a description`);
  }
});

test('every policy page, except contact and pricing, says when it was last updated', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const url of ['/terms', '/privacy', '/refunds', '/shipping', '/pricing']) {
    const { text } = await site.get(url);
    assert.match(text, /Last updated: \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d\./, url);
  }
});

test('the policy pages follow the same security rules as the other pages', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const sources = ['legal.html', ...Object.keys(POLICY).map((u) => `legal/${u.slice(1)}.html`)];
  for (const file of sources) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} has an inline script`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file} has an inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${file} has a javascript: link`);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i, `${file} loads a script from another site`);
  }
  for (const url of Object.keys(POLICY)) {
    const res = await site.get(url);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self' https:\/\/\*\.razorpay\.com/, url);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
  }
});

test('the files that hold the words of the policy pages are not served as they are', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const url of ['/legal.html', '/legal', '/legal/terms.html', '/legal/privacy.html', '/legal/contact.html', '/terms.html', '/public/legal/terms.html', '/css/..%2flegal%2fterms.html']) {
    assert.equal((await site.get(url)).status, 404, `${url} must not be served`);
  }
});

test('every page has the footer links to all six policy pages, and each of them works', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const url of [...OTHER_PAGES, ...Object.keys(POLICY)]) {
    const res = await site.get(url);
    assert.equal(res.status, 200, url);
    const footer = footerOf(res.text);
    assert.ok(footer, `${url} has a footer`);
    let last = -1;
    for (const [href, label] of Object.entries(FOOTER_LINKS)) {
      const at = footer.indexOf(`<a href="${href}">${label}</a>`);
      assert.ok(at > -1, `the footer of ${url} links to ${href} as "${label}"`);
      assert.ok(at > last, `the footer of ${url} lists ${href} in the usual order`);
      last = at;
    }
    for (const href of hrefsIn(footer)) assert.equal((await site.get(href)).status, 200, `${url} footer link ${href} works`);
  }
});

test('the links inside the policy pages lead to pages that exist', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const seen = new Set();
  for (const url of Object.keys(POLICY)) {
    const { text } = await site.get(url);
    const main = /<main[\s\S]*?<\/main>/.exec(text)[0];
    for (const href of hrefsIn(main)) seen.add(href);
  }
  assert.ok(seen.has('/refunds') && seen.has('/lookup') && seen.has('/contact') && seen.has('/pricing'), 'the pages point at each other');
  for (const href of seen) assert.equal((await site.get(href)).status, 200, `${href} works`);
});

test('the pricing page shows the real rates, the days they apply to and the bay counts', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/pricing');
  for (const expected of ['₹40 per hour', '₹60 per hour', '₹20 per hour', '₹30 per hour', '200 bays', '250 bays', 'Monday to Friday', 'Saturday and Sunday', 'from 1 to 4', '3 × ₹40', 'no booking fee']) {
    assert.ok(text.includes(expected), `the pricing page should say "${expected}"`);
  }
  assert.match(text, /<th scope="col">Weekdays/);
  assert.match(text, /<th scope="row">Two-wheeler/);
});

test('rates and days changed in the settings show up on the pricing page', async (t) => {
  const site = await makeSite({ env: { RATE_CAR_WEEKDAY: '55', RATE_CAR_WEEKEND: '75', RATE_BIKE_WEEKDAY: '25', RATE_BIKE_WEEKEND: '35', WEEKEND_DAYS: '5,6' } });
  t.after(() => site.close());
  const { text } = await site.get('/pricing');
  for (const expected of ['₹55 per hour', '₹75 per hour', '₹25 per hour', '₹35 per hour', 'Friday and Saturday', 'Monday, Tuesday, Wednesday, Thursday and Sunday', '3 × ₹55']) {
    assert.ok(text.includes(expected), `the pricing page should say "${expected}"`);
  }
  assert.ok(!text.includes('₹40'), 'the old rate is gone');
});

test('the terms follow the settings: hold time, booking length, how far ahead, and the bay counts', async (t) => {
  const site = await makeSite({ env: { HOLD_MINUTES: '7' } });
  t.after(() => site.close());
  const { text } = await site.get('/terms');
  for (const expected of ['7 minutes', '1 to 4 hours', '7 days ahead', '200 bays for cars and 250 for two-wheelers', 'Razorpay', 'Find my booking', 'laws of India']) {
    assert.ok(text.includes(expected), `the terms should say "${expected}"`);
  }
  assert.ok((await site.get('/refunds')).text.includes('7 minutes'), 'the refund policy uses the same hold time');
});

test('the refund policy gives Razorpay’s refund time and says refunds are for the full amount, to the original payment method', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/refunds');
  for (const expected of ['5 to 10 working days', 'full amount', 'same card, UPI ID, bank account or wallet', 'Before your booking starts', 'You cannot cancel on the website yet', 'pay_']) {
    assert.ok(text.includes(expected), `the refund policy should say "${expected}"`);
  }
});

test('no page quotes an older refund time than the one Razorpay gives', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  for (const url of [...OTHER_PAGES, ...Object.keys(POLICY)]) {
    const { text } = await site.get(url);
    assert.doesNotMatch(text, /5 to 7 working days|5-7 (working|business) days/i, url);
  }
  assert.ok((await site.get('/')).text.includes('5 to 10 working days'), 'the home page answer gives the right time');
});

test('the privacy policy says what is kept, who else sees it, and that the vehicle number can be looked up', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/privacy');
  for (const expected of ['vehicle number', 'Razorpay', 'Anyone who knows your vehicle number', 'does not set cookies', 'does not ask for your name, phone number or email', 'about a day', 'HTTPS', 'We do not sell your information']) {
    assert.ok(text.includes(expected), `the privacy policy should say "${expected}"`);
  }
});

test('the shipping page says nothing is posted and where the booking appears', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/shipping');
  for (const expected of ['Nothing is shipped', 'Find my booking', 'booking reference']) {
    assert.ok(text.includes(expected), `the shipping page should say "${expected}"`);
  }
});

test('business details from the settings appear on the contact page and in the policies, escaped', async (t) => {
  const site = await makeSite({
    env: { BUSINESS_NAME: 'Park & Co <i>Ltd</i>', BUSINESS_ADDRESS: '12 "MG" Road <b>, Indore', SUPPORT_PHONE: '+91 (98765) 43-210', SUPPORT_EMAIL: 'help@example.com' },
  });
  t.after(() => site.close());
  const contact = (await site.get('/contact')).text;
  assert.ok(contact.includes('<dt>Business name</dt><dd>Park &amp; Co &lt;i&gt;Ltd&lt;/i&gt;</dd>'), 'the business name is shown, escaped');
  assert.ok(contact.includes('<dt>Address</dt><dd>12 &quot;MG&quot; Road &lt;b&gt;, Indore</dd>'), 'the address is shown, escaped');
  assert.ok(contact.includes('<a href="tel:+919876543210">+91 (98765) 43-210</a>'), 'the phone number is a link that keeps only the digits and the plus sign');
  assert.ok(contact.includes('<a href="mailto:help@example.com">help@example.com</a>'), 'the email is a link');
  for (const url of Object.keys(POLICY)) {
    const { text } = await site.get(url);
    assert.ok(!text.includes('<i>Ltd'), `${url} must not contain the raw business name`);
    assert.ok(!text.includes('<b>, Indore'), `${url} must not contain the raw address`);
  }
  for (const url of ['/terms', '/privacy']) {
    assert.ok((await site.get(url)).text.includes('Park &amp; Co &lt;i&gt;Ltd&lt;/i&gt;'), `${url} names the business`);
  }
  // "contact us" lines show both ways of reaching the business.
  const refunds = (await site.get('/refunds')).text;
  assert.ok(refunds.includes('Email <a href="mailto:help@example.com">help@example.com</a> or call <a href="tel:+919876543210">'), 'the support line has the email and the phone');
});

test('without business details the contact page still says how to reach the lot', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/contact');
  assert.ok(text.includes('<dt>Business name</dt><dd>Bayfind</dd>'), 'the business name falls back to the site name');
  assert.ok(text.includes('Ask at the parking office.'));
  assert.ok(!text.includes('<dt>Address</dt>') && !text.includes('<dt>Phone</dt>') && !text.includes('<dt>Email</dt>'), 'no empty rows');
  const refunds = (await site.get('/refunds')).text;
  assert.ok(refunds.includes('Ask at the parking office.'), 'the refund policy falls back the same way');
});

test('"contact us" lines name the phone when only a phone is set, and the email when only an email is set', async (t) => {
  const phoneOnly = await makeSite({ env: { SUPPORT_PHONE: '98765 43210' } });
  t.after(() => phoneOnly.close());
  const a = (await phoneOnly.get('/')).text;
  assert.ok(a.includes('Call <a href="tel:9876543210">98765 43210</a>.'), 'phone only');
  assert.ok(!a.includes('mailto:'));
  const emailOnly = await makeSite({ env: { SUPPORT_EMAIL: 'help@example.com' } });
  t.after(() => emailOnly.close());
  const b = (await emailOnly.get('/')).text;
  assert.ok(b.includes('Email <a href="mailto:help@example.com">help@example.com</a>.'), 'email only');
  assert.ok(!b.includes('tel:'));
});

test('a site name with special characters is escaped on the policy pages too', async (t) => {
  const site = await makeSite({ env: { SITE_NAME: 'Park & Go<b>"' } });
  t.after(() => site.close());
  for (const url of Object.keys(POLICY)) {
    const { text } = await site.get(url);
    assert.ok(text.includes('Park &amp; Go&lt;b&gt;&quot;'), `${url} shows the escaped name`);
    assert.ok(!text.includes('Go<b>'), `${url} must not contain the raw name`);
  }
});

test('business details are read from the settings, trimmed and kept to a sensible length', () => {
  const none = loadConfig({});
  assert.equal(none.businessName, 'Bayfind', 'the business name falls back to the site name');
  assert.equal(none.businessAddress, '');
  assert.equal(none.supportPhone, '');
  assert.equal(loadConfig({ SITE_NAME: 'Acme' }).businessName, 'Acme');
  const set = loadConfig({ SITE_NAME: 'Acme', BUSINESS_NAME: '  Acme Parking Pvt. Ltd.  ', BUSINESS_ADDRESS: ' 1 Main Road ', SUPPORT_PHONE: ' 12345 ' });
  assert.equal(set.businessName, 'Acme Parking Pvt. Ltd.');
  assert.equal(set.businessAddress, '1 Main Road');
  assert.equal(set.supportPhone, '12345');
  const long = loadConfig({ BUSINESS_NAME: 'n'.repeat(500), BUSINESS_ADDRESS: 'a'.repeat(500), SUPPORT_PHONE: '9'.repeat(500) });
  assert.equal(long.businessName.length, 80);
  assert.equal(long.businessAddress.length, 240);
  assert.equal(long.supportPhone.length, 30);
  assert.equal(loadConfig({ BUSINESS_NAME: '   ', SITE_NAME: 'Zed' }).businessName, 'Zed', 'a blank business name falls back too');
});

test('the home page FAQ points to the refund policy', async (t) => {
  const site = await makeSite();
  t.after(() => site.close());
  const { text } = await site.get('/');
  assert.ok(text.includes('<a href="/refunds">cancellation and refund policy</a>'));
});
