# Bayfind Smart Parking

A parking website where drivers book a bay by **vehicle number** and pay online with **Razorpay**.
It is set up for one lot with **200 four-wheeler bays** and **250 two-wheeler bays**.
(“Bayfind” is just a placeholder name. Change it with `SITE_NAME`, see section 4.)

| | Weekdays (Mon–Fri) | Weekends (Sat–Sun) |
|---|---|---|
| 4-wheeler | ₹40 an hour | ₹60 an hour |
| 2-wheeler | ₹20 an hour | ₹30 an hour |

**What you get**

- **Book a bay** (`/book`): choose 4-wheeler or 2-wheeler, type the vehicle number, pick a day, a start time and 1 to 4 hours, pick a bay (or let the site choose one) and pay.
- **Razorpay checkout**: the real Razorpay payment popup, in free test mode (no real money) or live mode. There is no pretend payment on a live site: without Razorpay keys, booking is switched off.
- **Find my booking** (`/lookup`): type a vehicle number to see its current and upcoming bookings with the bay and the time.
- **Admin pages** (sign in at `/login` as the admin; government officials see the same pages, read only, with their own login from the owner's **Officials** page, `/officials`): **Dashboard** (`/dashboard`: free and used bays, today's payments, a bay map, anything that needs attention), **Business** (`/business`: money collected today, this week, this month and all time, how full the lot is, repeat customers, best weekdays and months, top customers, the Razorpay connection, who can do what), **Bookings** (`/bookings`: every booking with search, filters, a spreadsheet download and cancel-and-refund), **Customers** (`/customers`: every account with what each has spent) and **Analytics** (`/analytics`: money per day and the busiest hours).
- **Cancel and refund** (on the dashboard): type a vehicle number, confirm, and the bay is freed and the full amount goes back to the driver through Razorpay.
- **Policy pages** (`/pricing`, `/terms`, `/privacy`, `/refunds`, `/shipping`, `/contact`): plain-language pages that Razorpay checks for before it allows live payments. They fill in your prices, hold time and business details by themselves. Read them and adjust them to how you really run the lot (sections 7 and 8).
- **Chat assistant** (the yellow **Ask us** button in the corner of the public pages): drivers ask about prices, free bays, how to book, how to find a booking, refunds and how to reach the lot. It works at once with built-in answers made from your own settings and the live bay count. Add an Anthropic key and an AI writes the answers instead (section 3, “The chat assistant”). It cannot book, cancel or refund anything, and it never sees a booking.
- **Saved bookings**: every booking is saved in a file, so nothing is lost when you stop and start the site.

It is a website only (no phone app). It is built with Node.js and plain HTML, CSS and JavaScript. There is no database to install and no build step.

---

## 1. Run it on your computer

1. **Install Node.js.** Go to <https://nodejs.org>, download the **LTS** version (it must be 20.12 or newer) and install it with the default options.
2. **Unzip** this folder somewhere you can find it, for example in Documents.
3. **Open a terminal inside this folder.**
   - *Windows:* open the folder in File Explorer, click the address bar at the top, type `cmd` and press Enter.
   (If you use PowerShell and it says “running scripts is disabled”, use `cmd` as described here instead.)
   - *Mac:* open the Terminal app, type `cd ` (with a space after it), drag the folder from Finder into the Terminal window and press Enter.
4. Type this and press Enter (only the first time; it needs the internet):

   ```
   npm install
   ```

5. Start the site:

   ```
   npm start
   ```

6. Open <http://localhost:3000> in your browser.

To stop the site press **Ctrl+C** in the terminal. To start it again run `npm start`.

### Without Razorpay keys

On your own computer, with nothing else set up, the payment step is only **simulated** (you press a button on a payment page) so that you can try the pages, and a coloured strip says so. A site that runs with `NODE_ENV=production` (which every hosting guide here sets) **never** pretends: with no Razorpay keys, booking is switched off, the booking page says it is temporarily unavailable, and the admin's pages say what to add.

---

## 2. Try the real Razorpay checkout (test mode: free, no real money)

1. Create a free account at <https://razorpay.com> and log in to the Dashboard.
2. Switch the toggle at the top of the Dashboard to **Test Mode**.
3. Open **Account & Settings → API Keys** (under *Website and app settings*) and press **Generate Key**. Copy the **Key Id** (it starts with `rzp_test_`) and the **Key Secret**. The Dashboard does not show the secret again afterwards, so copy it straight away.
4. In this folder, make a copy of the file `.env.example` and name the copy `.env`. In the terminal:
   - *Windows:* `copy .env.example .env`
   - *Mac or Linux:* `cp .env.example .env`
5. Open `.env` in Notepad (or any text editor) and fill in the two keys:

   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   ```

6. Stop the site (Ctrl+C) and start it again (`npm start`). The terminal now says **TEST MODE**, and the strip on the pages says “Razorpay test payments: use Razorpay’s test cards, no real money is taken”.

Make a booking. When the Razorpay popup opens, pay with a **test card**:

- Visa `4111 1111 1111 1111` or Mastercard `5267 3181 8797 5449`
- any expiry date in the future, any 3-digit CVV, any name
- if a test bank page appears, choose **Success**

Razorpay's testing guide suggests trying UPI in live mode, so use cards while you are testing. You can see your test payments in the Razorpay Dashboard (in Test Mode) under **Transactions → Payments**.

Keys that start with `rzp_test_` never move real money. Keys that start with `rzp_live_` do.

> **Keep your Key Secret private.** It lives only in `.env`. Never paste it into a web page, send it to anyone, or upload `.env` anywhere. The browser only ever receives the Key Id, which is meant to be public.

### Handy while testing

- One vehicle number cannot have two overlapping paid bookings, so use a different vehicle number for each test. Or free the vehicle number by cancelling the test booking from the dashboard (section 3): in test mode that sends the test payment back, with no real money involved.
- To wipe all test bookings: stop the site, delete the `data` folder, and start it again.

---

## 3. How booking and payment work

1. The driver picks the vehicle, types the vehicle number, and chooses the day, start time, length and bay.
2. The site **holds that bay for 10 minutes** and asks Razorpay for an *order* for the exact price. The price is worked out on the server, so it cannot be changed from the browser.
3. The Razorpay popup opens. **Card, UPI and bank details go to Razorpay only**; they never touch this site.
4. When the payment succeeds, Razorpay gives the browser a payment ID and a signature. The browser passes them to the site, and the server **checks the signature with the Key Secret** before it marks the booking as paid.
5. The driver sees a confirmation with the bay and a booking reference. They can look it up later with the vehicle number.

If something goes wrong in between, the site handles it:

- **Paid but the page closed or the connection dropped?** About a minute after the hold ends the site asks Razorpay about the order and confirms the booking by itself. If you set up the webhook (section 6) it happens instantly.
- **Paid after the 10 minutes, and the bay was meanwhile taken by someone else?** The site **refunds the payment automatically** and tells the driver.
- **Paid twice for one booking?** The second payment is flagged in the terminal so you can refund it from the Razorpay Dashboard.

### Rules the site enforces

- Starts on the hour or half hour, 1 to 4 hours long, up to 7 days ahead.
- The price depends on the day the booking **starts** (weekday or weekend rate). A Friday evening booking that runs past midnight still uses the Friday rate.
- All dates and times use one clock, India Standard Time by default, whatever the visitor's device says.
- Vehicle numbers use the standard Indian format, for example `MP 09 AB 1234`, `KA 01 1234` or `DL1CAB1234`. Bharat (BH) series numbers are not supported.

### The operator dashboard

Open `/dashboard`. It asks for a user name (`operator`, or whatever you set in `OPERATOR_USER`) and the password you put in `OPERATOR_PASSWORD`. **Set a long password before the site is on the internet.** While the password is empty the dashboard is open to anyone who can reach the site, which is fine on your own computer and nowhere else.

“In use” on the dashboard means “has a paid booking right now”. No sensors or cameras are connected.

### Accounts and roles (Admin, Government official and Customer)

The site has three roles.

| Role | Who | What they can do |
| --- | --- | --- |
| **Admin** (the owner) | The lot operator. Signs in at `/login` with the user name `operator` (or `OPERATOR_USER`) and `OPERATOR_PASSWORD`. Nobody can become an admin by signing up. | **Everything**: see every booking and every customer, search and download bookings as a spreadsheet, see the money collected and the busiest times, cancel and refund bookings, see the Razorpay connection and run the Setup check. |
| **Government official** | A login the owner creates on the **Officials** page (`/officials`: name, office, email, password; the owner can also set a new password or remove a login, which signs that official out at once). Officials sign in at `/login` with their email. Nobody can become an official by signing up. | **All the data, read only**: every booking and every customer, all payments and numbers, the spreadsheet download. They cannot cancel or refund, run the Setup check, add sample data or create logins (403). To let officials refund as well, add `bookings:cancel-refund` to the `official` list in `src/roles.js`. |
| **Customer** | Anyone who creates an account at `/signup` (name, email, password). | Book a bay, and see their own bookings at `/account`. A customer who opens a staff page (`/dashboard`, `/business`, `/bookings`, `/customers`, `/analytics`) gets "Staff only" (403), and the staff data requests answer 403 too. |

By default a customer must sign in before booking (`CUSTOMER_LOGIN_REQUIRED=off` lets anyone book without an account). Every booking made while signed in belongs to that customer, and the browser cannot choose whose booking it is. Passwords are kept only as scrypt hashes in `users.json` next to `bookings.json`; the sign-in is a signed, HttpOnly, SameSite cookie (`SESSION_SECRET` is optional: without it a random key is kept in the data folder). Wrong passwords are limited per connection and per account. Scripts can still use the operator password with HTTP Basic.

To try the site on your own computer, `SEED_TEST_CUSTOMER=on` creates a customer, `customer@example.com` with the password `Customer@123`, and shows it on the sign-in page. It is never created once Razorpay keys are set, and it is off unless you ask for it.

### Analytics for the operator

`/analytics` (Admin only) shows the **money collected on any day** and the **busiest hours**: tiles for the day's collection, the busiest hour and the last 7, 14, 30 or 90 days; a 24-hour chart of vehicles parked or arriving (all, cars or two-wheelers; an average day or one chosen day) with the peak hour highlighted; the money collected each day; the car and two-wheeler split; and a few plain-language findings. Money counts payments received that day, minus bookings that were cancelled and refunded, the same rule as the dashboard. Vehicles parked is worked out from paid bookings (not sensors). On your own computer (simulated payments only) the page can add about two weeks of clearly marked **sample bookings**; a live site never offers them, so its numbers are always real.

### Free AI answers for the chat (any question)

Without an AI key the chat gives built-in answers about parking (prices, free bays, booking, refunds, accounts, the time) and says honestly when it does not know. To let it answer **any** question, give it an AI key. There are two ways:

- **Free:** make a free key at Google AI Studio (aistudio.google.com) for Gemini, or at console.groq.com for Groq. Then add `AI_API_KEY` (the key) and `AI_PROVIDER` (`gemini`, the default, or `groq`) to your settings. `AI_MODEL` changes the model. `AI_PROVIDER=custom` with `AI_BASE_URL` and `AI_MODEL` works with any service that speaks the OpenAI chat format. Free plans have their own daily limits; when one is reached (or the service is down) the chat goes on with the built-in answers.
- **Paid:** `ANTHROPIC_API_KEY` (the Claude AI model). It is used first when both are set.

With an AI key the chat can still look up live free bays and prices, never invents prices or bay counts, and declines harmful requests. What visitors type in the chat is sent to the AI service you chose; the privacy page says which one. Never put a key in chat messages or on GitHub: type it only into Render's Environment page or your `.env` file.

### Cancelling a booking and refunding it

Drivers cannot cancel on their own: there are no accounts, so the site cannot tell who is asking. You can, from the dashboard:

1. Find the box **Cancel and refund a booking** (at the top of the dashboard) and type the vehicle number. You can also press **Cancel…** next to a payment in the Recent payments table.
2. The site lists that vehicle's paid bookings that have not ended yet. Press **Cancel and refund** and then confirm.
3. The bay is freed straight away and the **full amount** is sent back to the driver's original payment method through Razorpay. How soon it reaches the driver depends on their bank (usually 5 to 10 working days).

Good to know:

- It always refunds the whole amount. For a partial refund, use the Razorpay Dashboard.
- Only a booking that has not ended can be cancelled here. For one that has already ended, refund the payment in the Razorpay Dashboard.
- If Razorpay does not accept the refund, the booking is still cancelled and its bay is free, and it appears under **Needs attention** together with what Razorpay said. Fix the cause and press **Retry refund**. If you send the money back by hand in the Razorpay Dashboard instead, press **Retry refund** once afterwards: the site sees that the payment was already refunded and clears the entry.
- If the server was stopped or restarted while a refund was being sent (an update does that), nobody knows whether the refund went through. The booking appears under **Needs attention** and says so. Press **Retry refund**. This is safe: Razorpay does not refund the same payment in full twice, so if the first try did get through, the booking is simply marked as refunded.
- A cancelled and refunded booking is taken out of the money figures at the top of the dashboard. It stays in the Recent payments list, marked “Cancelled, refunded”.
- In test mode nothing was paid, so cancelling just cancels.
- The cancel buttons are protected by the same operator password as the dashboard, so set one before the site goes online. They also only work from the dashboard page itself, so a link or form on another website cannot trigger a refund.

### The chat assistant

Every public page (not the dashboard) has a yellow **Ask us** button in the bottom-right corner. It opens a chat window where a driver can ask what parking costs, whether bays are free now or at a later time, how to book, how to find a booking, how refunds work and how to reach the lot. An answer can come with buttons (such as **Book a bay**, **Find my booking** or **Call us**) and a small card that shows the free bays. On a phone the window fills the screen. The chat lives in the driver's browser tab and is gone when the tab is closed.

It answers in one of two ways:

- **Instant answers.** No setup and no cost. The site matches the question to a topic and answers from your own settings: your prices, hold time and contact details, and the live count of free bays. Drivers get these until you add a key, and again whenever the AI cannot answer.
- **AI answers.** Written by Anthropic's Claude AI model, which understands questions worded in any way and replies in the driver's own language (English, Hindi, Hinglish and so on). They start when you add an Anthropic key (the steps are below). If the AI cannot be reached for any reason (no credit left, no internet from the server, a busy moment), the driver simply gets an instant answer.

**What it can and cannot do.** It can tell the prices and the free bays, and send drivers to the right page. It **cannot** book, cancel, refund or look up a booking, and it never sees a booking, a name, a phone number or a payment. The AI is given two read-only lookups (free bays, and the price of a stay) and nothing else. The window tells drivers not to type card details, and says that answers can be wrong. The answers follow your settings, so when you change a price in `.env` the chat follows it: there is nothing to edit.

**Turn on the AI answers (optional)**

1. Make an account on the Anthropic Console, <https://platform.claude.com>. It is separate from a Claude chat subscription and is billed on its own.
2. Open **Billing** (<https://platform.claude.com/settings/billing>) and add a card or credit. Anthropic's prices are in US dollars, so for a card from an Indian bank switch on international online payments first.
3. Recommended: make a **workspace** just for this website (<https://platform.claude.com/settings/workspaces>) and set a monthly **spend limit** on it, so the bill cannot go past the amount you chose. (The Default Workspace cannot have a spend limit, which is why a separate one is worth the minute.)
4. Open **API keys** (<https://platform.claude.com/settings/keys>) and press **Create key**. Name it `parking-site` and, if you made a workspace, choose it. **Copy the key at once**: it starts with `sk-ant-` and is shown only one time.
5. Put the key in your settings as `ANTHROPIC_API_KEY`: in `.env` on your own computer or server, or in the **Environment** page of Render (DEPLOY-RENDER.md, “Optional extra: the AI chat answers”). Then start the site again (on Render: **Save and deploy**). The terminal says `Chat        AI assistant` when it worked.
6. Open `/dashboard`, scroll to **Setup check** and press **Run the check**. Its **Chat assistant** part says how drivers are being answered. Ask the chat something yourself and run the check again: it shows how many questions went to the AI today and, if the AI is not answering, why.

Keep the key as private as your Razorpay Key Secret: it lives only in `.env` (or Render's Environment page), never on a web page and never on GitHub. If it ever leaks, delete it on the Anthropic keys page and make a new one.

**What it costs.** Anthropic bills each AI answer to your own Anthropic account. Unless you choose another model with `CHAT_MODEL`, the site uses `claude-haiku-5-5`, which Anthropic's pricing page (<https://platform.claude.com/docs/en/about-claude/pricing>) lists at $0.10 per million input tokens and $0.50 per million output tokens for prompts under 100,000 tokens (a chat here sends a few thousand). An ordinary answer therefore costs a small fraction of one US cent, and a few thousand answers come to about one dollar. That is an estimate: prices change, so check that page and the usage figures on your own Anthropic account. These fences hold whatever drivers do:

- The whole site gives at most `CHAT_DAILY_LIMIT` AI answers a day, counted on the lot's clock (500 unless you change it). Even if every one of them were as long as the chat allows, that is a few US dollars a day at the very most. Past the limit drivers get instant answers until the next day.
- One visitor gets at most 40 AI answers an hour and can send at most 15 chat messages a minute. A message can be at most 500 characters long, and at most 20 AI answers are written at the same moment.
- The spend limit you set on Anthropic's side (step 3) is the last fence, and it is yours.

**Privacy.** With the AI on, what a driver types in the chat, together with the last few messages of that same chat, is sent to Anthropic so that it can write the answer. The site itself keeps nothing: it does not save the chat and does not write it to its log. The `/privacy` page changes by itself to say so (it says the answers come from the site alone when there is no key, and leaves the chat out when you switch it off). Read it, like the other policy pages (section 8).

**Switching it off, or changing it**

- `CHAT_ENABLED=off` hides the chat window on every page.
- `CHAT_DAILY_LIMIT=0` keeps the window but stops the AI (instant answers only) even if the key is still there. Another number changes the daily limit.
- `CHAT_MODEL` chooses another AI model, for example `claude-sonnet-5-5`, which is more capable and, at the time of writing, 20 times the price of the default. Use the exact name from Anthropic's documentation: a wrong name makes the Setup check say that the model was not found.
- The built-in answers and the instructions given to the AI are in `src/chat.js`. The window is `public/js/chat.js` (its words and the six starting questions) and `public/css/chat.css` (its looks). Restart the site after a change.

---

## 4. Settings (the `.env` file)

Every setting is optional. After changing `.env`, stop the site (Ctrl+C) and start it again. Lines that start with `#` are notes. Keep passwords simple (letters, numbers and dashes) so nothing in them is mistaken for a comment.

| Setting | What it does | Default |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Your Razorpay keys. Required for payments. With both empty, a site in production switches booking off (on your own computer the payment is only simulated). Live keys (`rzp_live_…`) also switch booking off on storage that is wiped at every restart (Render's free size). | empty |
| `RAZORPAY_WEBHOOK_SECRET` | Secret for the optional webhook (section 6). | empty |
| `OPERATOR_USER`, `OPERATOR_PASSWORD` | The admin's sign-in (for `/login` and every admin page). | `operator`, empty |
| `CUSTOMER_LOGIN_REQUIRED` | `off` lets anyone book without an account. | on |
| `SESSION_SECRET` | Optional key that signs the sign-in cookies. Without it a random key is kept in the data folder. | not set |
| `SEED_TEST_CUSTOMER` | `on` makes a test customer with a published password, for trying the site on your own computer (see Accounts and roles). Never made with Razorpay keys set. | off |
| `SITE_NAME` | The name shown on every page (up to 40 characters). | `Bayfind` |
| `SUPPORT_EMAIL` | Shown in the footer and in messages that say “contact us”. Empty means “ask at the parking office”. | empty |
| `BUSINESS_NAME` | Your business name as it is on your Razorpay account. Shown on the Contact, Terms and Privacy pages (up to 80 characters). | the `SITE_NAME` |
| `SUPPORT_PHONE` | A phone number for the Contact page and the “contact us” lines. Razorpay wants one on a live site. | empty |
| `BUSINESS_ADDRESS` | The address on the Contact page, on one line (up to 240 characters). | empty |
| `RATE_CAR_WEEKDAY`, `RATE_CAR_WEEKEND` | 4-wheeler price per hour, in rupees. | `40`, `60` |
| `RATE_BIKE_WEEKDAY`, `RATE_BIKE_WEEKEND` | 2-wheeler price per hour, in rupees. | `20`, `30` |
| `WEEKEND_DAYS` | Which days use the weekend price: `0` = Sunday … `6` = Saturday. | `0,6` |
| `HOLD_MINUTES` | How long a bay is held while the driver pays. | `10` |
| `UTC_OFFSET_MINUTES` | The lot's clock, in minutes ahead of UTC. `330` is India. | `330` |
| `AI_API_KEY`, `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL` | A free (or any OpenAI-compatible) AI for the chat: see “Free AI answers for the chat”. | empty, `gemini` |
| `ANTHROPIC_API_KEY` | Your Anthropic key, so that an AI writes the chat answers (section 3, “The chat assistant”). It starts with `sk-ant-`. Keep it private. Empty means built-in answers only. | empty |
| `CHAT_ENABLED` | `off` (or `0`, `false`, `no`) hides the chat window on every page. | on |
| `CHAT_MODEL` | The AI model that writes the chat answers. | `claude-haiku-5-5` |
| `CHAT_DAILY_LIMIT` | The most questions the whole site sends to the AI in a day (a try that fails counts too). Past it, drivers get built-in answers until the next day. `0` turns the AI off while the key stays in place. | `500` |
| `PORT` | The port the site listens on. | `3000` |
| `DATA_DIR` | The folder where `bookings.json` is saved. | the `data` folder here (on Render: the disk, in `/var/data/test` or, with live keys, `/var/data/live`) |
| `HOST` | Which network address to listen on. | this computer only; everyone in production |
| `NODE_ENV` | Set to `production` on the live server (section 7). | not set |
| `TRUST_PROXY` | Set to the number of proxies your host puts in front of the site (usually `1`), so each visitor is counted separately. The dashboard's **Setup check** shows which number is right. | not set (on Render: `1`) |
| `DISABLE_CSP` | Set to `1` only to find out whether the browser's security rules are blocking the Razorpay popup (section 9). | not set |

### Change the lot size or the zone names

Open `public/js/shared.js` and find the block that starts with `const LOT`. It holds, for each vehicle type, the number of bays (`total`), the bays in each zone (`perZone`) and the zone names. **`total` must equal `perZone` times the number of zones.** Save the file and restart. The pages, the availability counts and the dashboard follow automatically. Bays are numbered `C001`–`C200` for 4-wheelers and `B001`–`B250` for 2-wheelers.

Do this before you take real bookings. Making the lot smaller later can leave existing bookings pointing at bays that no longer exist. (A few automated checks expect 200 and 250 bays, so they will report a failure after you change this. That is expected.)

The booking length (1 to 4 hours), the half-hour start times and the 7-day limit are set in `src/config.js`.

---

## 5. Where your bookings are kept (a file, or a free database)

By default bookings are saved to `data/bookings.json`, and customer accounts to `data/users.json`, after every change. **Back this folder up.** It is created the first time the site runs. If the file is ever damaged, the site moves it aside (as `bookings.json.corrupt-…`) and starts with an empty list instead of failing.

Unpaid holds and cancelled bookings older than a day are tidied away. Paid bookings are kept.

### Or in a database (`DATABASE_URL`)

Set `DATABASE_URL` to the address of any Postgres database and the site keeps the bookings and the customer accounts there instead, and writes no files at all. This is how a **free Render service can keep real bookings**: Render's free size forgets its files at every restart, a database does not. [Neon](https://neon.com) has a free Postgres (its plan page lists 1 GB of storage per project, and the database sleeps after 5 idle minutes and wakes by itself in about a second). The click-by-click steps are in `DEPLOY-RENDER.md`, under "Real money on the free size".

- **Nothing to set up in the database.** The site creates its one table, `bayfind_docs`, by itself.
- **Test and live records are kept apart**, like the test and live folders on a Render disk: when you change from Razorpay test keys to live keys the site starts with a clean list, so test bookings can never block a bay.
- **The site never starts "empty" by mistake.** At start it loads everything from the database; if it cannot reach it (it waits about 30 seconds for a sleeping one) it stops with a clear message instead of selling bays that are already paid for.
- **Money moments wait for the database.** A customer is sent to the payment window only after the booking, with its Razorpay order, is safely saved; if the database is down, booking pauses ("Nothing was charged") and the owner's Setup check turns red. A payment, and a refund that is about to be sent, are saved before the site moves on. Everything else is saved in the background and tried again until it works.
- **Updates.** For a few seconds during an update two copies of the site run. A payment that reaches the new copy for a booking only the old copy knew is found in the database.
- **Back up** with the CSV download on the owner's Bookings page. Your database provider may keep its own history; check what it offers.

## 6. Webhook (recommended once the site is online)

A webhook lets Razorpay tell your site straight away when a payment is captured, even if the driver closed their browser right after paying. The site also checks by itself about a minute after a hold ends, so a payment is not lost without the webhook, but the webhook makes it instant.

Razorpay cannot reach `localhost`, so set this up after the site is online:

1. In the Razorpay Dashboard open **Account & Settings → Webhooks → Add New Webhook** (the menu names can differ a little between dashboard versions).
2. **Webhook URL:** `https://YOUR-SITE/api/razorpay/webhook`
3. **Secret:** make up a long random text (not your Key Secret) and put the same text in `.env` as `RAZORPAY_WEBHOOK_SECRET`.
4. Tick the events **payment.captured** and **order.paid**.
5. Save, then restart the site.

---

## 7. Putting it on the internet

**The easy way: a small server with automatic HTTPS.** [`DEPLOY.md`](DEPLOY.md) is a step-by-step guide for someone who has never run a server. It uses an ordinary Ubuntu or Debian server and the scripts in the `deploy/` folder. One command installs Node.js and the Caddy web server (which gets and renews the HTTPS certificate by itself), starts the site so that it comes back after a crash or a reboot, opens only the ports the site needs, and makes a copy of your bookings every night. Updating later means uploading the new zip and running one script, and a version that does not start is rolled back by itself.

**Render (render.com): no server to look after.** [`DEPLOY-RENDER.md`](DEPLOY-RENDER.md) is a step-by-step guide that goes as far as real Razorpay payments. You put the folder on GitHub, and the file `render.yaml` tells Render to build the site, keep a small disk for the bookings and check `/healthz`. Render gives the HTTPS padlock by itself. It needs the paid size (about $7 a month, plus $0.25 for the disk): the free size forgets all files at every restart. For a no-cost demo, `render-free.yaml` sets the site up on the free size instead, with nothing to type: Render makes up the admin password itself, and booking stays off until you add Razorpay test keys (nothing is pretended). That size goes to sleep after 15 minutes without visitors and forgets every booking whenever it sleeps, restarts or is updated, so it is never for real customers (see “A free demo first” in `DEPLOY-RENDER.md`). On Render the site chooses two settings by itself: `TRUST_PROXY` is `1`, and the bookings go in the disk's `test` folder while Razorpay test keys are in use and in its `live` folder once live keys are, so test bookings never mix with real ones. The dashboard's **Setup check** shows the proxy number the host really needs and whether the bookings are on the disk.

**Any other host.** You need a host that

- runs Node.js 20.12 or newer,
- serves the site over **HTTPS** (needed for live payments and good practice anyway),
- keeps your files on a **persistent disk**. Bookings live in a file, so a host that wipes its disk when it restarts will wipe your bookings. Point `DATA_DIR` at the persistent folder,
- runs **one copy** of the site. The booking file is not shared between several servers.

Then:

1. **Activate your Razorpay account.** Razorpay asks for your business details and bank account (KYC) before live keys work. After that, switch the Dashboard to **Live Mode** and generate **Live** keys.
2. **Set these on your host** (as environment variables, or in a `.env` file): `NODE_ENV=production`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (the live ones), `RAZORPAY_WEBHOOK_SECRET`, `OPERATOR_PASSWORD` (long and unique), `DATA_DIR`, `SITE_NAME`, `SUPPORT_EMAIL`, `ANTHROPIC_API_KEY` only if you want an AI to answer in the chat (section 3), and `TRUST_PROXY=1` if the host uses a proxy.
3. **Fill in `BUSINESS_NAME`, `SUPPORT_PHONE` and `BUSINESS_ADDRESS`, and read the policy pages** (`/pricing`, `/terms`, `/privacy`, `/refunds`, `/shipping`, `/contact`). Razorpay checks that a shop has them before it allows real payments, and asks for their web addresses on the activation form.
4. **Start with an empty `data` folder** so test bookings do not block real bays.
5. In the Razorpay Dashboard open **Account & Settings → Payments and refunds → Capture and refund settings** and keep **Auto-capture all payments** (Razorpay's default). With manual capture a driver could end up with a booking whose payment is never collected.
6. **Set up the webhook** (section 6).
7. **Do one real payment.** Book the cheapest slot (a 2-wheeler for 1 hour on a weekday is ₹20), pay it for real, check that it appears in Razorpay and on `/dashboard`, then cancel it from the dashboard (**Cancel and refund a booking**), which sends the money back and frees the bay. Because it is a real booking, stop the site and delete the `data` folder once more before you open to the public.
8. Back up the `data` folder regularly.

In production mode the site is stricter on purpose: booking switches itself off until Razorpay keys are present, and the dashboard stays off until `OPERATOR_PASSWORD` is set. `/healthz` gives a short `{"ok":true}` reply, for hosting platforms that want a health-check address.

Razorpay charges you its own fee on each payment (see its pricing page). The driver pays exactly the parking price shown, with nothing added.

---

## 8. What this version does not do (please read before launching)

- **No driver accounts and no sign-in.** The vehicle number is how a booking is found. That means anyone who knows a vehicle number can see when and where it is booked. The site holds no names, phone numbers or email addresses.
- **No emails or text messages.** The confirmation is on screen, and “Find my booking” shows it again later. Razorpay may send its own payment receipt.
- **The chat assistant can be wrong, and it cannot act.** The built-in answers follow your settings. An AI answer is written by a model that sometimes makes mistakes, which the chat window says under the typing box, so keep the prices and the policy pages right: they are what drivers can rely on. The assistant cannot look at, change, cancel or refund a booking (the operator does that on the dashboard). With the AI on, what drivers type in the chat goes to Anthropic (section 3, “Privacy”), so read `/privacy` and have it checked like the other policy pages. The costs are small and capped (section 3, “What it costs”), but they are yours.
- **Drivers cannot cancel or change a booking themselves.** The operator can cancel and fully refund one from the dashboard (section 3). There is no change or extend button: to stay longer, book the next time slot.
- **If you refund a payment by hand in the Razorpay Dashboard, the site is not told**, so the bay stays reserved for that time. Use **Cancel and refund** on the dashboard instead.
- **The site refunds by itself only when a bay is lost** (section 3). Every other refund is your decision.
- **No protection against people who start bookings and never pay**, which holds a bay for 10 minutes each time. There is a limit on how many attempts one visitor can make, but add a CAPTCHA or phone verification before a large public launch.
- **Nothing is connected to the gate, cameras or sensors.** A bay is reserved by time only.
- **One server, one file.** This suits a lot of this size (hundreds of bookings a day). If you grow beyond that, move the bookings to a real database.
- **No tax invoices.** If your business needs GST invoices, talk to your accountant; Razorpay's Dashboard keeps the payment records.
- **The policy pages are plain-language starting points, not legal advice.** Read each one and change what does not match how you run the lot, above all the cancellation rule on `/refunds`. Have a lawyer or your accountant look at them before you take real money. They say nothing about who is responsible for a vehicle or what is left inside it, and nothing about GST: ask your accountant whether GST applies to your parking and how it has to be shown. The words are in the `public/legal` folder (plain HTML). When you change a page, also change the “Last updated” date on it (the line that starts with `<p class="updated">`). After a change, upload the folder again and run the setup (DEPLOY.md, step 11).

---

## 9. If something goes wrong

| What you see | What to do |
|---|---|
| “This site needs Node.js 20.12 or newer” | Install the current LTS version from <https://nodejs.org>. |
| “Port 3000 is already in use” | Close the other program, or add `PORT=3001` to `.env`. |
| You changed `.env` but nothing changed | Stop the site (Ctrl+C) and start it again. |
| The pages say “Test mode: payments are simulated” although you added keys | Check that **both** keys are filled in, with no spaces or quotes, and that the file is named exactly `.env`. Windows Notepad often saves it as `.env.txt`. Use the `copy` command from section 2 instead, and in File Explorer turn on *View → File name extensions* to check. |
| The terminal says “Authentication failed” from Razorpay | The Key Id and Key Secret do not belong together, or a test key is mixed with a live key. Generate the pair again. |
| The Razorpay popup does not open, or is blank | Press **F12**, open the **Console** tab and look for a message that starts with “Refused to …”. That means the browser's security rules blocked something Razorpay needs. Add `DISABLE_CSP=1` to `.env` and restart to confirm it is the cause. Then add the blocked address to the policy in `src/app.js` (the function `securityHeaders`) and turn `DISABLE_CSP` off again, because leaving it on removes a protection. |
| A driver paid but has no booking | Wait a few minutes: the site re-checks unconfirmed payments about a minute after the hold ends. The terminal log says what it found. If the booking still does not appear, refund the payment from the Razorpay Dashboard. |
| The dashboard says “Refund needed” | A refund did not go through. The message shows what Razorpay said. Fix that, then press **Retry refund**. If the message says the server restarted while the refund was being sent, nobody knows whether it went through: press **Retry refund**. That is safe, because Razorpay does not refund the same payment in full twice; if the first try did go through, the booking is marked as refunded and nothing more is sent. If you refund the payment by hand in the Razorpay Dashboard instead, press **Retry refund** once afterwards so the site clears the entry. |
| Pressing “Cancel and refund” says “This server has no Razorpay keys right now” | The booking was paid for with real Razorpay keys, and those keys are missing from `.env` now. Put them back and restart the site. |
| The site runs on a server (DEPLOY.md) and something looks wrong | Run `sudo bash /opt/bayfind/deploy/check.sh`. It lists what works and what does not, and says what to do about each problem. DEPLOY.md, step 11, has more. |
| The chat window has no button, or the **Ask us** button is gone | The chat is switched off: look for `CHAT_ENABLED=off` in `.env` (or in Render's Environment page), remove it and restart. The dashboard never has the button. |
| You added `ANTHROPIC_API_KEY` but the chat still says “Instant answers”, or the dashboard says “The AI is not answering” | Open `/dashboard`, **Setup check**, **Run the check**: the **Chat assistant** part says what is wrong. The usual causes: the key was copied in part, or has a space or quotes around it (it must start with `sk-ant-`) (401); there is no credit or a payment problem on the Anthropic Billing page (402); `CHAT_MODEL` names a model that does not exist (404); a spend limit or rate limit on the Anthropic account has been reached (429); or the server cannot reach the internet. Nothing is lost meanwhile: drivers get the built-in answers. If you only just added the key, check that you restarted the site. |
| “This vehicle already has a booking that overlaps this time” | One vehicle number can hold only one paid booking at a time. Use “Find my booking” to see it. |

---

## 10. Checking the code

```
npm test
```

runs the automated checks in about fifteen seconds. They use a temporary data folder and a pretend Razorpay, so they never touch your real bookings or your Razorpay account. Each check should show a tick (✔, or `ok` on older Node versions), and the summary near the end should say `fail 0`.

## 11. What is in this folder

```
server.js        starts the site (reads .env, checks the Node version, prints the status)
src/
  app.js         pages, the API, the webhook and the security headers
  bookings.js    the booking rules: holds, prices, conflicts, payment confirmation, refunds
  payments.js    Razorpay: creating orders, checking signatures
  store.js       saving bookings to data/bookings.json
  config.js      reads the settings
  ratelimit.js   limits on how fast one visitor can ask for things
  chat.js        the chat assistant: built-in answers, the AI call, the limits and the daily count
  words.js       plain-English words for days and lists, used by the pages and the chat
  errors.js      error messages
public/          what the browser receives: the HTML pages, css/, js/, img/ and fonts/
                 (the chat window is js/chat.js and css/chat.css)
  legal.html     the frame (header, footer) around the policy pages
  legal/         the words of the policy pages: pricing, terms, privacy, refunds, shipping, contact
deploy/          the scripts and files that put the site on a server (DEPLOY.md explains them)
test/            the automated checks
render.yaml      tells Render (render.com) how to run the site (DEPLOY-RENDER.md explains it)
render-free.yaml the same for Render's free size: a demo with nothing to type, no disk, bookings not kept
DEPLOY.md        the step-by-step guide to putting the site on a server you rent
DEPLOY-RENDER.md the step-by-step guide to putting the site on Render, with real Razorpay payments
data/            made on first run: bookings.json (back this up)
.env             your own settings and keys (you create it; never share it)
```

The fonts (Bricolage Grotesque and DM Sans) are included in `public/fonts` under the SIL Open Font License; the licence texts are next to the font files.
