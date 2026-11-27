# Load test

How the website behaves when many people use it at once, measured with [autocannon](https://github.com/mcollina/autocannon). Run it yourself with `npm run loadtest`; the figures below are from one run on the machine described next, so yours will differ.

## How it was measured

- **Machine:** 2 x Intel Xeon 2.30 GHz, 8 GB memory, Linux, Node v22. The site ran as its own process (simulated payments, bookings saved to a file in a temporary folder). The load generator ran on the same machine and shared its processors, so a separate machine would show somewhat better figures. A free Render instance has far less processor than this machine and will be slower; these figures are not a promise for it.
- **A "connection"** is one person using the site at the same moment, who sends the next request as soon as the last one is answered. Real people stop to read, so this is harder than real traffic.
- **Every request came from a different address** (sent in the `X-Forwarded-For` header), like a crowd of different phones. Without that, the limits that stop one address from flooding the site (tested separately) would answer "too many requests" and the booking code would hardly be exercised. The site only believes that header when `TRUST_PROXY` is set, which the script does for the site it starts.
- Each scenario ran for 10 seconds.

| Scenario | What each request does |
|---|---|
| home | `GET /`: the home page |
| availability | `GET /api/availability`: "which bays are free?", the question every booking starts with (a different vehicle, day and time each time) |
| hold-bay | `POST /api/bookings`: starts a booking and holds a bay (a different vehicle, zone, day and time each time) |
| journey | one whole visit as four requests: availability, hold a bay, confirm the payment, open the pass. Each of the four is counted as a request below |

## Results: 50 people at once

| Scenario | Requests/s | Avg latency (ms) | Median (ms) | 97.5th (ms) | 99th (ms) | Slowest (ms) | Requests | 2xx | 4xx | 5xx | Errors and time-outs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| home | 6,705 | 7.0 | 6 | 13 | 16 | 179 | 67,046 | 67,046 | 0 | 0 | 0 |
| availability | 11,030 | 4.0 | 4 | 7 | 10 | 119 | 110,289 | 110,289 | 0 | 0 | 0 |
| hold-bay | 300 | 163.4 | 160 | 301 | 309 | 605 | 3,305 | 3,305 | 0 | 0 | 0 |
| journey | 263 | 188.1 | 172 | 222 | 1,185 | 4,886 | 2,888 | 2,888 | 0 | 0 | 0 |

Memory used by the site's process at its highest: 229 MB

## Results: 200 people at once

| Scenario | Requests/s | Avg latency (ms) | Median (ms) | 97.5th (ms) | 99th (ms) | Slowest (ms) | Requests | 2xx | 4xx | 5xx | Errors and time-outs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| home | 6,339 | 31.0 | 28 | 39 | 49 | 2,753 | 63,391 | 63,391 | 0 | 0 | 0 |
| availability | 10,696 | 18.2 | 17 | 31 | 35 | 77 | 106,959 | 106,959 | 0 | 0 | 0 |
| hold-bay | 312 | 602.4 | 587 | 1,128 | 1,150 | 1,169 | 3,124 | 3,124 | 0 | 0 | 0 |
| journey | 237 | 282.6 | 177 | 1,368 | 4,902 | 9,857 | 2,372 | 2,372 | 0 | 0 | 232 |

Memory used by the site's process at its highest: 235 MB

The columns: *Requests/s* is the average over the run; *latency* is the time from sending a request to receiving the whole answer; *97.5th* and *99th* mean that 97.5% or 99% of requests were answered at least that fast; *4xx* are requests the site refused (for example a full zone or a rate limit), *5xx* are server errors; *Errors and time-outs* are requests that got no answer within 10 seconds.

## What the figures say

- **Reading is fast.** The home page and the availability check each answer in about 4 to 7 ms at 50 people at once, at several thousand requests a second. A 450-bay lot will never see anything close to that.
- **Booking is the slowest step**, at about 300 holds a second with 50 people at once (about 18,000 a minute). That is far more than a 450-bay lot needs, but it is the part that would be felt first. The reason is how the file storage works: every change rewrites the whole bookings file, so the more bookings there are, the longer each save takes. (In an earlier run on an almost empty file the same step managed about 530 a second with 20 people; it settled near 300 as the file grew over the test.) With a Postgres database (`DATABASE_URL`) the changes are saved in the background instead, and this cost does not apply the same way; it was not measured here.
- **At 200 people all booking non-stop** the site stays up and nothing it answered was an error, but answers slow down: in the whole-visit scenario 1 request in 100 took about 5 seconds, the slowest took almost 10, and 232 requests (about 9%) got no answer within the 10 seconds allowed. That is the limit of one process on this machine. It takes 200 people, each sending the next request the instant the last is answered, so it is a stress test and not a forecast of a normal day.
- **No server errors** (0 in the 5xx column) in any scenario, and the site's memory stayed near 230 MB.

## Does it stay correct under a crowd?

Speed is not the only question: two people must never get the same bay, and one payment must never count twice. `test/concurrency.test.js` sends requests at the same instant and checks the records afterwards:

- 120 people book the same hour in a zone of 50 bays: exactly 50 get a bay, each a different one, and the other 70 are told the zone is full.
- Bookings whose times overlap only partly share bays without ever clashing.
- The same vehicle asked for ten times at once leaves one hold, not ten.
- 50 payments confirmed at once: each booking is paid exactly once, with its own payment.
- The browser and Razorpay both confirm the same payment at the same moment: it counts once and nothing is refunded.
- One entry QR scanned by twenty phones at once lets one vehicle in.

This holds because the site decides each of these in one step before it waits for anything else (a bay is chosen and saved before the payment order is created, for example), so two requests cannot both win.

## Running it

```
npm install                # the load tester is a development tool, so it is not installed on the live site
npm run loadtest           # 50 connections, 10 seconds each
npm run loadtest -- --connections 100 --duration 20 --out LOAD-TEST-RESULTS.md
npm run loadtest -- --url https://your-site.onrender.com --connections 5
```

With `--url` the site is tested where it is running. A proxy in front of it (Render has one) does not trust the `X-Forwarded-For` header your computer sends, so every request looks like it comes from your computer and the site's limits answer **429 "Too many requests"**: that is the protection working, and the table counts those in the *4xx* column. Use few connections there, and only on a site you own.
