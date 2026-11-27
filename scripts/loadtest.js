#!/usr/bin/env node
'use strict';

/*
 * A load test of the website, made with autocannon.
 *
 *   npm run loadtest                      starts the site on this computer (its own process, a temporary data folder,
 *                                         simulated payments) and tests it
 *   npm run loadtest -- --connections 100 --duration 20
 *   npm run loadtest -- --out LOAD-TEST-RESULTS.md      also writes the table to a file
 *   npm run loadtest -- --url https://your-site.onrender.com   tests a site that is already running (see the notes below)
 *
 * Each "connection" is one person using the site at the same moment, who sends the next request as soon as the last one is
 * answered. That is harder than real people, who stop to read, so the figures are a stress test, not a forecast of visitors.
 *
 * The scenarios
 *   home           the home page
 *   availability   "which bays are free?", the question every booking starts with
 *   hold-bay       starting a booking: a different vehicle, zone, day and time each time
 *   journey        a whole visit: availability, hold a bay, confirm the payment, open the pass
 *
 * Notes
 *   - Every request carries a different X-Forwarded-For address, the way a crowd of different phones would, so the site's
 *     per-address limits (which are there to stop one person flooding it) do not answer instead of the booking code. The
 *     site only believes that header when TRUST_PROXY is set, which this script does for the site it starts itself.
 *   - Against a site that is already running (--url) a proxy usually replaces that header, so every request looks like it comes
 *     from this computer and the limits will answer 429 "Too many requests". That is the limit working; the table counts those.
 *     Use a small number of connections there, and only on a site you own.
 *   - The site and the load generator run on the same computer. The site runs in its own process, but they still share the
 *     processor, so a separate machine would show somewhat better figures. A free Render instance is much slower than a laptop.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const autocannon = require('autocannon');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const connections = Math.max(1, Number(option('connections', 50)) || 50);
const duration = Math.max(1, Number(option('duration', 10)) || 10);
const outFile = option('out', null);
const externalUrl = option('url', null);

const pad = (n, w = 2) => String(n).padStart(w, '0');
const lotDate = (plusDays) => {
  const d = new Date(Date.now() + 330 * 60000 + plusDays * 86400000); // the lot clock is UTC+5:30
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const pick = (list) => list[Math.floor(Math.random() * list.length)];
let counter = 0;
const crowd = () => {
  counter += 1;
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
};
const plate = () => {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  return `MP${pad(1 + Math.floor(Math.random() * 70))}${pick(letters)}${pick(letters)}${pad(Math.floor(Math.random() * 10000), 4)}`;
};
const slot = () => {
  const vehicle = pick(['car', 'bike']);
  const zones = vehicle === 'car' ? 4 : 5;
  return { vehicle, zone: Math.floor(Math.random() * zones), plate: plate(), date: lotDate(1 + Math.floor(Math.random() * 6)), time: `${pad(6 + Math.floor(Math.random() * 14))}:00`, hours: 1 + Math.floor(Math.random() * 3) };
};
const availabilityPath = () => {
  const s = slot();
  return `/api/availability?vehicle=${s.vehicle}&date=${s.date}&time=${s.time}&hours=${s.hours}`;
};
const json = { 'content-type': 'application/json' };

// ---- Starting the site ---------------------------------------------------------------------------------------------------
async function startSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayfind-load-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, TRUST_PROXY: '1', NODE_ENV: '', CUSTOMER_LOGIN_REQUIRED: 'off', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', DATABASE_URL: '' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('The site did not start: ' + stderr);
    try {
      if ((await fetch(url + '/healthz')).ok) return { url, child, dir };
    } catch (err) {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The site did not answer within 10 seconds.');
}

// The memory the site's process is using (Linux only; elsewhere the figure is left out).
const rssMb = (pid) => {
  try {
    const kb = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return kb ? Number(kb[1]) / 1024 : null;
  } catch (err) {
    return null;
  }
};

// ---- The scenarios -----------------------------------------------------------------------------------------------------
const scenarios = [
  { name: 'home', about: 'GET /', requests: [{ method: 'GET', path: '/', setupRequest: (req) => withCrowd(req) }] },
  { name: 'availability', about: 'GET /api/availability', requests: [{ method: 'GET', setupRequest: (req) => withCrowd({ ...req, path: availabilityPath() }) }] },
  {
    name: 'hold-bay',
    about: 'POST /api/bookings',
    requests: [{ method: 'POST', path: '/api/bookings', setupRequest: (req) => withCrowd({ ...req, headers: { ...req.headers, ...json }, body: JSON.stringify(slot()) }) }],
  },
  {
    name: 'journey',
    about: 'availability, hold, confirm payment, pass',
    requests: [
      { method: 'GET', setupRequest: (req, context) => ((context.mine = crowd()), withCrowd({ ...req, path: availabilityPath() }, context.mine)) },
      {
        method: 'POST',
        path: '/api/bookings',
        setupRequest: (req, context) => ((context.body = slot()), withCrowd({ ...req, headers: { ...req.headers, ...json }, body: JSON.stringify(context.body) }, context.mine)),
        onResponse: (status, body, context) => {
          context.booking = null;
          if (status === 201) {
            try {
              context.booking = JSON.parse(body).booking.id;
            } catch (err) {
              // left as null
            }
          }
        },
      },
      {
        method: 'POST',
        path: '/api/payments/demo-confirm',
        setupRequest: (req, context) => withCrowd({ ...req, headers: { ...req.headers, ...json }, body: JSON.stringify({ bookingId: context.booking || 'bk_none' }) }, context.mine),
        onResponse: (status, body, context) => {
          context.pass = null;
          if (status === 200) {
            try {
              context.pass = JSON.parse(body).booking.pass;
            } catch (err) {
              // left as null
            }
          }
        },
      },
      { method: 'GET', setupRequest: (req, context) => withCrowd({ ...req, path: context.pass ? context.pass.replace('/pass?', '/api/pass?') : '/api/pass?t=none' }, context.mine) },
    ],
  },
];
function withCrowd(req, address) {
  req.headers = { ...(req.headers || {}), 'x-forwarded-for': address || crowd() };
  return req;
}

function run(url, scenario) {
  return new Promise((resolve, reject) => {
    autocannon({ url, connections, duration, requests: scenario.requests, title: scenario.name, timeout: 10 }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

// ---- The report ----------------------------------------------------------------------------------------------------------
const fmt = (n, digits = 0) => (n === undefined || n === null ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
function row(scenario, r, peakMb) {
  const by = r.statusCodeStats || {};
  const ok = (r['2xx'] || 0);
  const refused = Object.entries(by).filter(([code]) => code !== '0' && Number(code) >= 400 && Number(code) < 500).map(([code, v]) => `${code}: ${fmt(v.count)}`).join(', ') || '0';
  return `| ${scenario.name} | ${fmt(r.requests.average)} | ${fmt(r.latency.average, 1)} | ${fmt(r.latency.p50)} | ${fmt(r.latency.p97_5)} | ${fmt(r.latency.p99)} | ${fmt(r.latency.max)} | ${fmt(r.requests.total)} | ${fmt(ok)} | ${refused} | ${fmt(r['5xx'] || 0)} | ${fmt((r.errors || 0) + (r.timeouts || 0))} |`;
}

async function main() {
  let site = null;
  let url = externalUrl;
  if (!url) {
    site = await startSite();
    url = site.url;
  }
  const cpus = os.cpus();
  const header = [
    `Load test with autocannon ${require('autocannon/package.json').version} on Node ${process.version}`,
    `Machine: ${cpus.length} x ${cpus[0] ? cpus[0].model.trim() : 'cpu'}, ${Math.round(os.totalmem() / 1024 ** 3)} GB memory, ${os.platform()}`,
    `Site: ${externalUrl ? externalUrl : 'started by this script (own process, simulated payments, file storage in a temporary folder)'}`,
    `Settings: ${connections} connections (people at once), ${duration} seconds each scenario`,
  ];
  console.log(header.join('\n') + '\n');

  const lines = [
    '| Scenario | Requests/s | Avg latency (ms) | Median (ms) | 97.5th (ms) | 99th (ms) | Slowest (ms) | Requests | 2xx | 4xx | 5xx | Errors and time-outs |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|',
  ];
  let peak = 0;
  const sampler = site ? setInterval(() => (peak = Math.max(peak, rssMb(site.child.pid) || 0)), 500) : null;
  try {
    for (const scenario of scenarios) {
      process.stderr.write(`Running ${scenario.name} (${scenario.about}) for ${duration} seconds...\n`);
      const result = await run(url, scenario);
      lines.push(row(scenario, result));
      console.log(lines[lines.length - 1]);
    }
  } finally {
    if (sampler) clearInterval(sampler);
    if (site) {
      peak = Math.max(peak, rssMb(site.child.pid) || 0);
      site.child.kill();
      fs.rmSync(site.dir, { recursive: true, force: true });
    }
  }
  const footer = site && peak ? `\nMemory used by the site's process at its highest: ${Math.round(peak)} MB` : '';
  console.log(footer);
  if (outFile) {
    fs.writeFileSync(outFile, header.map((l) => `- ${l}`).join('\n') + '\n\n' + lines.join('\n') + '\n' + footer + '\n');
    console.log(`Written to ${outFile}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
