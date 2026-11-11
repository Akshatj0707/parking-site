# Putting your parking website online with Render

This guide takes you from the zip file on your computer to a real website with its own address, for example `https://parking.yourname.in`, that drivers can use to book and pay, with **real Razorpay payments**. It uses **Render** (render.com), a company that runs websites for you. You do not rent or look after a server, you do not type commands, and the padlock (HTTPS) is automatic.

**Render or a server?** Render is the easier road and costs about $7.25 a month, paid in US dollars by card. The other road, in `DEPLOY.md`, rents a plain server for about ₹500 to ₹700 a month and needs a little more patience. Both end in the same website. Pick one; you do not need both.

**Want to try it for free first?** See “A free demo first”, after the table of steps. It costs nothing and needs no typing to create, but booking stays **switched off until you add Razorpay's test keys** (nothing is pretended: a customer always pays in Razorpay's own window, and the payment shows in your Razorpay Dashboard). It forgets its bookings, so it is a demo and never a shop.

**How long it takes:** about 1 to 2 hours for steps 1 to 7, most of it waiting. Going live with real money takes longer, because Razorpay has to approve your business first (step 8).

**If someone else will do this for you:** give them the zip, this guide, and the logins for GitHub, Render, your domain seller and Razorpay.

## What you will end up with

```
A driver's phone --> your domain --> Render --------------------> your parking site --> your bookings
  https://parking.yourname.in        padlock (HTTPS), restarts     the code from GitHub     saved on a Render disk
```

- **HTTPS (the padlock)** is set up and renewed by Render. It is free.
- The site **restarts by itself** after a crash. Render checks the address `/healthz` every few seconds.
- Your **bookings are saved on a disk** that Render keeps when the site restarts or is updated. Render copies the disk once a day and keeps the copies for 7 days.
- **Updating** the site means putting the changed files on GitHub and pressing one button in Render. If a new version misbehaves, one more button puts the old one back.
- **Test bookings and real bookings are kept in separate folders** on the disk, chosen by the kind of Razorpay key you use, so nothing from your testing can ever block a real bay.

## What it costs

| What | Price | Notes |
|---|---|---|
| Render: the site | $7 a month | the 0.5 CPU, 512 MB size. A lot of this size does not need more. |
| Render: the disk | $0.25 a month | 1 GB. Bookings take very little room. |
| Render: a free demo (optional) | $0 | `render-free.yaml`, for trying the site with Razorpay test keys only. It sleeps when nobody visits and forgets its bookings. See “A free demo first”. |
| GitHub | free | a private repository |
| A domain name | about ₹500 to ₹1,500 a year | from any domain seller |
| Razorpay | a fee on each payment | see Razorpay's pricing page. The driver pays exactly the parking price shown. |
| Anthropic: AI answers in the chat | a small fraction of a US cent per answer, with a daily cap | optional, billed apart by Anthropic. The chat works without it. See “Optional extra” after step 9. |

These are the prices on Render's own pages on 24 October 2026; they change, so look at [render.com/pricing](https://render.com/pricing) before you pay. Render bills in **US dollars** to a card. In your bank's app, switch on international online payments for that card first. Render's pages do not say whether Indian GST is added; your first invoice shows it.

**Render's free size cannot be used for a real site.** It forgets every file whenever it restarts, which would erase your bookings, and it falls asleep when nobody visits. A site that takes money needs the paid size and a disk. The free size is good for one thing: a demo with Razorpay test keys (see “A free demo first”, after the table of steps). If you put live keys on it, the site switches booking off by itself, so no customer ever pays real money for a booking that could be lost.

## What to know before you start

- **A short pause at every update.** Because the site keeps its bookings on a disk, Render stops the old version a few seconds before the new one starts, and in between the site does not answer. A driver who pays during those seconds is not lost: Razorpay keeps trying to tell the site for up to 24 hours, and the site also asks Razorpay by itself about a minute after a hold ends. Even so, update at a quiet hour.
- **One copy only.** The bookings are one file on one disk, so the site cannot run as several copies at once. That is fine for a lot of this size.
- **The backup is Render's daily disk copy** (step 9), plus the payment records in your Razorpay Dashboard. There is no nightly file copy of your own.
- **Render does not say how many of its own servers sit between a visitor and your site.** The site needs that number to count each visitor separately. It starts with a sensible guess, and the dashboard's **Setup check** (step 4) tells you whether the guess is right.

## How a payment is checked

Real money needs more than a "payment done" message from the driver's browser, because anyone can fake that. This is what the site does, so that a real payment is believed and a fake one is not:

1. **The site decides the price.** When a driver presses Book, the site works out the amount itself (from your rates, the time and the bay) and asks Razorpay for an **order** for exactly that amount. The browser cannot change it.
2. **The driver pays in Razorpay's own window.** The card or UPI details, and the bank's own check of the driver (the one-time code, the UPI PIN, and so on), happen on Razorpay's and the bank's pages. The site never sees a card number.
3. **Razorpay signs the result.** After a successful payment Razorpay gives the browser three things: the order number, the payment number and a **signature**. The signature is a code that only Razorpay and you can work out, because it is made with your **Key Secret**.
4. **The site checks the signature before it believes anything.** It works the code out again with the Key Secret and compares. If it does not match, the payment is ignored and the driver sees "We could not verify this payment". Only a match turns the bay into a paid booking.
5. **A second, separate message: the webhook.** Razorpay also calls your site directly, at `/api/razorpay/webhook`, when a payment is captured. That call is signed with the **webhook secret**. The site checks the signature against the exact bytes it received, and also checks that the amount and the currency are what the booking expects. This covers a driver who pays and closes the browser straight away.
6. **A third safety net.** About a minute after a hold runs out, the site asks Razorpay whether that order was paid, and settles it if so.
7. **A payment that arrives too late is never kept for nothing.** If the bay was taken while the driver was paying, the site sends the full amount back by itself.

The four secrets, and where each one lives:

| Secret | What it does | Where it is kept |
|---|---|---|
| Razorpay **Key Id** (starts `rzp_test_` or `rzp_live_`) | Tells Razorpay which account is asking. Not secret, but keep it with the others. | Render: `RAZORPAY_KEY_ID` |
| Razorpay **Key Secret** | Signs and checks payments, and lets the site create orders and send refunds. | Render: `RAZORPAY_KEY_SECRET`. Never on GitHub, never in a message. |
| **Webhook secret** | Proves that a webhook call really comes from Razorpay. | Render: `RAZORPAY_WEBHOOK_SECRET`, and the same text in Razorpay's webhook page |
| **Dashboard password** | Opens `/dashboard`, where you cancel bookings and send refunds. | Render: `OPERATOR_PASSWORD` |

Razorpay keeps two separate worlds. In **test mode** the bank window is a pretend page with Success and Failure buttons, so no real bank check happens and no money moves. In **live mode** the driver's own bank asks for the real check, and real money moves. Test keys and live keys never work in each other's world.

## The steps at a glance

| # | What you do | Time |
|---|---|---|
| 1 | Get ready: accounts and details | 20 min |
| 2 | Put the site on GitHub | 10 min |
| 3 | Create the site on Render | 15 min |
| 4 | Run the dashboard's Setup check | 5 min |
| 5 | Your own web address (domain) | 15 min, then wait up to an hour |
| 6 | Tell Razorpay about your website (the webhook) | 5 min |
| 7 | Test everything with test payments | 20 min |
| 8 | Go live with real payments | a few days (Razorpay checks your business) |
| 9 | Everyday care: updates, backups, if something breaks | as needed |
| Extra | Let an AI answer in the chat (optional) | 15 min |

## A free demo first (optional)

Render has a free size, and the file `render-free.yaml` in your repository sets the site up on it. It costs nothing and **needs no typing to create it**: you press one button and Render makes up the admin password by itself. **Nothing is pretended.** Until you add Razorpay's **test keys** (next section), booking is switched off and the admin pages say why; with the keys, every payment goes through Razorpay's own payment window and shows up in your Razorpay Dashboard, still without real money. It is a **demo**, not a shop. These differences matter:

| | Free demo (`render-free.yaml`) | Real site (`render.yaml`) |
|---|---|---|
| Price | $0 | about $7.25 a month |
| When nobody visits | It goes to sleep after 15 minutes. The next visitor waits about a minute while it wakes up. | Always awake |
| Bookings and customer accounts | **Erased** whenever the site sleeps, restarts or is updated (Render may also restart it at any time), unless you connect a free database (see "Real money on the free size" below) | Kept on the disk |
| Payments | Razorpay **test keys** (`rzp_test_…`): Razorpay's test window, no real money. Live keys switch booking off, unless a free database is connected. | Test keys first, then live (step 8) |
| Real customers and real money | Only with a free database connected (below), and after step 8 | Yes, after step 8 |

### The quick way: tap a link and press one button

1. Open this address. Replace `YOUR-GITHUB-NAME` with the name of the GitHub account that holds the repository: `https://render.com/deploy?repo=https://github.com/YOUR-GITHUB-NAME/parking-site/tree/free-demo`. It reads the branch `free-demo` of the repository, where the free demo is named `render.yaml`, the one name that a link like this can read. (The repository must be **public**, or Render must be allowed to read it.)
2. Sign in to Render if it asks. If you have no account, choose **Sign up with GitHub**. Render may ask you to add a card for verification, even for a free service. Render Support says that this is a temporary $1 hold that is reversed straight away, and that without a card Render would not let you create the service. The demo itself costs nothing. (Render's own page about free services does not mention a card.)
3. Render shows one web service, `parking-site-demo`, with **no boxes to fill in**. Press **Deploy Blueprint**.
4. Wait 3 to 6 minutes. Open the service and then its address, near the top of the page, for example `https://parking-site-demo-x1y2.onrender.com`. **Check:** you see the site, with a strip at the top that says **Online booking is temporarily unavailable** (that is correct until the test keys are added below). Adding `/healthz` to the address shows `{"ok":true}`.
5. Add the Razorpay test keys (next section), then try it: choose a vehicle, a time and a bay, pay in Razorpay's window with a test card, and look the booking up with its vehicle number.

**The admin pages.** Open `/login` on the same address and sign in. The user name is `operator`. You then get `/dashboard`, `/business`, `/bookings`, `/customers` and `/analytics`. Render made up the password, and it is not in any file on GitHub. To read it, open the service in Render, choose **Environment** in the left menu, and find `OPERATOR_PASSWORD` (Render may hide the value behind a button that shows it). If you cannot find a way to read it, or you would rather use a password of your own, press **Edit** next to it, type a long password of your own, and choose **Save and deploy**.

(Without the link: in Render press **New**, then **Blueprint**, connect the repository, and type `render-free.yaml` in the box called **Blueprint Path**. That shows the same service, also with no boxes.)

### Later: Razorpay's test payment window (optional)

Without keys, the site only shows that booking is off. To switch it on with Razorpay's real payment window, still with test money:

1. Get a pair of **test** keys: step 1, item 4 (in the Razorpay Dashboard switch to **Test Mode**, then open **API Keys** and choose **Generate Key**).
2. In Render open the service, choose **Environment**, press **+ Add Environment Variable**, and add `RAZORPAY_KEY_ID` (the Key Id, which starts `rzp_test_`) and `RAZORPAY_KEY_SECRET` (the Key Secret). Type them only there: never in a message or an email, and never on GitHub. Then choose **Save and deploy**.
3. After a minute the strip at the top of the site says **Razorpay test payments: use Razorpay’s test cards, no real money is taken**, and the pay button opens Razorpay's own window. Pay with a test card (step 7, item 3). Then open your Razorpay Dashboard, make sure the switch at the top says **Test Mode**, and open **Transactions → Payments**: the payment is there. (The old setting `DEMO_PAYMENTS` no longer exists: a site never pretends to take a payment.)
4. For the webhook (step 6), make up a webhook secret (step 1, item 5) and add it the same way, as `RAZORPAY_WEBHOOK_SECRET`. The webhook address is your `onrender.com` address, for example `https://parking-site-demo-x1y2.onrender.com/api/razorpay/webhook`. Open the site once first, so that it is awake when Razorpay looks.
5. To show your own name and details on the pages, add `SITE_NAME`, `BUSINESS_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE` and `BUSINESS_ADDRESS` under **Environment** and choose **Save and deploy**. Without them the demo shows the site's own name, Bayfind, and tells visitors to ask at the parking office.

Then follow steps 4, 6 and 7 as they are written, with these changes:

- **Step 4:** the Setup check shows a **red message** saying that the bookings are not on the Render disk, and the log shows a **WARNING** about it. On the free demo that is expected, because the free size has no disk. Leave the setting `DATA_DIR` as it is: without it the site would look for a disk that the free size does not have, and might not start. The dashboard password is the `OPERATOR_PASSWORD` under **Environment** (see above).
- **Step 7:** skip item 6 (bookings surviving a restart). On the free demo they do **not** survive one, by design. Make your test booking soon after the site wakes up, and look at it in the dashboard straight away.
- **Skip** step 3 (the link did it), step 5 (your own address), step 8 (real payments) and the backups in step 9, because there is nothing worth backing up. Step 1 is needed only for the test keys and the webhook secret.

### Real money on the free size: a free database

The free size forgets its files, so by itself it must not take real money. A **free database** fixes that: the site keeps its bookings and customer accounts in the database, and the site refuses to start without it, so a booking that was paid for is never lost. It costs nothing, and the free Render service stays free. You still need Razorpay's approval of your business and live keys (step 8), and you accept what the free size is: it sleeps after 15 minutes without visitors, and the next visitor waits about a minute for it to wake.

**Create the database (about 5 minutes).** These are the steps on Neon's site; a button may be named a little differently by the time you read this.

1. Open `neon.com` and choose **Sign up** (with GitHub, Google or an email address). Neon's plan page lists a Free plan with 1 GB of storage per project; it does not say whether a card is asked for. If Neon asks for one and you would rather not, any other Postgres database works the same way: all the site needs is its address.
2. Create a project: name it `bayfind`, and choose the region nearest the site, **AWS Asia Pacific (Singapore)**, because the Render demo is in Singapore.
3. On the project's page press **Connect** and copy the **connection string**. It starts with `postgresql://`, ends with `?sslmode=require`, and **contains your database password**. Treat it like a key.
4. In Render open the service, choose **Environment**, press **+ Add Environment Variable**, name it `DATABASE_URL`, paste the connection string as the value, and choose **Save and deploy**. Paste it only there: never in a message and never on GitHub.
5. **Check:** after a minute the site's log says `Bookings    saved in the database at …` and no longer shows the WARNING about the Render disk. In the owner's **Setup check**, the storage question is answered with **Yes. Bookings and customer accounts are kept in the database**. Make a test booking, then in Render choose **Manual Deploy → Deploy latest commit**: the booking is still there afterwards.

Then add your live Razorpay keys (step 8c) as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` under **Environment**. The site starts with a clean list of **live** bookings (the test ones stay apart in the database and never block a bay).

What to know:

- If the database is unreachable, booking pauses with "Nothing was charged" and the Setup check turns red; it resumes by itself when the database is back.
- Razorpay's webhook (step 6) is a safety net for customers who pay and then close the page. A sleeping free site cannot answer it at once, but Razorpay tries again, and the site also checks pending payments with Razorpay about once a minute while it is awake.
- The site stays free, but it is a small one: many visitors at the same time, a slow first visit after sleep, and no Render support. If it grows, move to `render.yaml` (about $7.25 a month); the database can stay as it is.

**When you want real customers:** do not turn the demo into the real site. Create the real one from `render.yaml` on the `main` branch (step 3, with **Blueprint Path** left as it is), and then delete the demo in Render (open the demo service, choose **Settings**, scroll to the bottom and press **Delete Web Service**), so that nobody finds it by mistake. Never put live keys (`rzp_live_…`) on the demo unless a database is connected (above): the site refuses to take bookings with live keys on temporary storage, because real payments would be taken for bookings that can be lost.

---

## Step 1. Get ready

You need:

1. **The zip file** (`bayfind-smart-parking.zip`), saved on your computer and **unzipped** into a fresh folder (Windows: right-click, **Extract All**; Mac: double-click). You get a folder called `bayfind-smart-parking`. Use a fresh unzip, not a copy you have already run on your computer, because a copy that has been run may hold a `.env` file with your keys in it.
2. **A card that Render accepts**, with international online payments switched on (see "What it costs").
3. **A free GitHub account** at <https://github.com>. This is where Render picks your site up from. Turn on two-step login in GitHub (**Settings → Password and authentication**).
4. **A free Razorpay account** with **test keys**, so you can try everything without real money:
   1. Create an account at <https://razorpay.com> and log in.
   2. Switch the toggle at the top of the Razorpay Dashboard to **Test Mode**.
   3. Open **Account & Settings → API Keys** (under *Website and app settings*) and press **Generate Key**.
   4. Copy the **Key Id** (starts with `rzp_test_`) and the **Key Secret**. Once you leave that screen, the Dashboard shows only the Key Id and not the Key Secret again, so paste both into a note on your computer right away. Razorpay lets only the account's Owner and Admin users see API keys.
5. **A webhook secret**: make up a long random text of at least 20 letters and digits (the "generate password" button of a password manager does it). You will type the same text in two places, Razorpay and Render. It is **not** your Key Secret.
6. **A dashboard password**: another long random text, with no space at the start or end. Whoever knows it can cancel bookings and send refunds.
7. **Your business details**: the name of your business as it is on your Razorpay account, an email address and a phone number for customers, and the address of the lot on one line. They are shown on the website's Contact, Terms and Privacy pages, and Razorpay checks them.

Keep the Key Secret, the webhook secret and the dashboard password private. Do not paste them into a chat, an email or a web page, except the boxes in this guide. Keep them in a password manager or on paper.

> **Never done this before?** You do not have to understand each screen. Do what each step says and compare what you see with what the guide says you should see. Every step says what to check before you go on.

## Step 2. Put the site on GitHub

Render picks up your site from a **GitHub repository**, which is a folder of files kept on GitHub. It must be **private**, so that only you can see it.

1. Log in at <https://github.com>. Press the **+** at the top right, then **New repository**.
2. **Repository name:** `parking-site`. Choose **Private**. Leave everything else empty: no README, no `.gitignore`, no licence. Press **Create repository**.
3. On the new, empty repository's page, press the link **uploading an existing file**. (Later you can find the same thing under **Add file → Upload files**.)
4. On your computer open the unzipped `bayfind-smart-parking` folder. **Select everything inside it** (press Ctrl+A on Windows, Cmd+A on a Mac) and **drag it into the browser window**. GitHub accepts folders. It allows up to 100 files at once and 25 MB per file; this site is about 65 small files.
5. When every file has finished loading, type a short note such as `First version` and press **Commit changes**.

**Check:** on the repository's main page, these must be listed **directly**: `render.yaml`, `package.json`, `package-lock.json`, `server.js`, and the folders `src`, `public`, `deploy` and `test`. If you see a single folder called `bayfind-smart-parking` instead, you uploaded the folder instead of what is inside it. Delete the repository (**Settings**, at the very bottom) and do this step again.

Two files whose names start with a dot, `.gitignore` and `.env.example`, are not needed by Render. If your upload leaves them out, that is fine.

**Never upload** a file called `.env`, or folders called `node_modules` or `data`. A fresh unzip has none of them.

*An alternative with a program:* [GitHub Desktop](https://desktop.github.com) can publish the folder as a private repository (**File → Add local repository**, then **Publish repository** with **Keep this code private** ticked; the labels may differ a little). It leaves out `.env`, `node_modules` and `data` by itself, because of the `.gitignore` file.

## Step 3. Create the site on Render

1. Go to <https://render.com> and press **Get Started**. Sign up **with GitHub**, which connects the two at once. Confirm your email if Render asks.
2. In the Render Dashboard press **New**, then **Blueprint**. (A *Blueprint* is a file, `render.yaml`, that tells Render what to build. You already uploaded it.)
3. If Render asks to connect GitHub, allow it to read **only the `parking-site` repository**. Then press **Connect** next to that repository.
4. **Blueprint name:** `parking`. **Branch:** `main`. Leave **Blueprint Path** as it is. (For the free demo, type `render-free.yaml` there instead: see “A free demo first”.)
5. Render shows what it will create: a **web service** called `parking-site`, with a **1 GB disk** called `parking-data` attached to it. (The free demo shows a web service called `parking-site-demo`, with no disk and no boxes to fill in at all: see “A free demo first”.) It also shows a box for each setting that `render.yaml` marks as private (`sync: false`). Fill them in:

   | Box | What to type |
   |---|---|
   | `RAZORPAY_KEY_ID` | The test **Key Id**, `rzp_test_…` (step 1.4) |
   | `RAZORPAY_KEY_SECRET` | The test **Key Secret** |
   | `RAZORPAY_WEBHOOK_SECRET` | The webhook secret you made up (step 1.5) |
   | `OPERATOR_PASSWORD` | The dashboard password (step 1.6) |
   | `SITE_NAME` | The name shown on every page, up to 40 characters, for example `Sunrise Parking` |
   | `BUSINESS_NAME` | The name of your business, as on your Razorpay account (up to 80 characters) |
   | `SUPPORT_EMAIL` | The email address customers can write to |
   | `SUPPORT_PHONE` | The phone number customers can call |
   | `BUSINESS_ADDRESS` | The address of the lot, on one line (up to 240 characters) |

   Type each value exactly, **without quotes** and without a space at the start or end. If a box does not appear, or you skip one, you can add the setting afterwards (step 4 shows where).
6. If Render asks for a card, add it. Render may make a small check charge (about $1) and returns it.
7. Press **Deploy Blueprint**.

Render now builds the site. It takes 3 to 6 minutes. Open the service `parking-site` and its **Logs** page. When it is ready, the log shows lines like these, and Render marks the service **Live**:

```
  Sunrise Parking is running
  ------------------------------------------------------------
  Website     port 10000
  Dashboard   port 10000/dashboard   (asks for the operator password)
  Bookings    saved in /var/data/test
  Payments    TEST MODE: Razorpay checkout with test keys, no real money moves
```

Near the top of the service's page is its address, like `https://parking-site-x1y2.onrender.com`. Open it.

**Check:** you see your site, with a strip saying **Test mode** at the top. Adding `/healthz` to the address shows `{"ok":true}`. The log says `Bookings saved in /var/data/test`.

If Render shows a red message instead of the list in item 5, read it: the commonest cause is that `render.yaml` is not at the top of the repository (see the check in step 2).

## Step 4. Run the dashboard's Setup check

The site has a built-in check, made for exactly this moment.

1. Open `https://YOUR-ADDRESS/dashboard` (your `onrender.com` address, or later your own domain). The browser asks for a user name and password: the user name is `operator`, and the password is the one you typed in `OPERATOR_PASSWORD`.
2. Scroll down to **Setup check** and press **Run the check**. It has four parts; the fourth, about the chat, matters only if you use the AI answers (see “Optional extra” after step 9).

**Telling visitors apart.** Visitors reach your site through Render's own servers, so the site must be told how many of them to look through (the setting `TRUST_PROXY`) to find a visitor's real address. With the wrong number the site may think that all visitors are one person, so that a few busy minutes make it say "Too many searches" to everyone. Or it may believe an address that a visitor made up. The check shows a table: for each number, the address the site would see for **you**.

- Open another tab, search the web for **what is my IP address**, and read your public address.
- The right number is the **lowest** one whose row shows exactly that address.
- If it is not the row marked **in use now** (the site starts with `1`), set it. In Render open your service and choose **Environment** in the left menu. Press **+ Add Environment Variable**, type `TRUST_PROXY` as the name and the right number as the value, then open the save menu and choose **Save and deploy**. Render starts the site again with the new value, which takes about a minute. (**Save only** keeps the value but changes nothing until the next deploy.) Run the check again.
- If your address appears in no row (for example, the other site shows an address with colons and the table one with dots), try again from another network, such as your phone's mobile data. If it still does not match, leave `TRUST_PROXY` as it is. The site works; only the limits that stop abuse are less exact.

**Secure connection.** It should say **Yes**. If it says it does not see the connection as HTTPS although you opened the page with `https://`, the `TRUST_PROXY` number is too low (for example `0`): set it as above.

**Where bookings are saved.** The folder should be `/var/data/test`, with a green line saying that it is on the Render disk. That is the folder the site chose by itself. If you see a red message instead, a setting named `DATA_DIR` is pointing somewhere outside the disk: delete that setting in Render's **Environment** page and choose **Save and deploy**. Bookings saved anywhere else are **lost every time the site restarts or is updated**. (**On the free demo** the folder is `/tmp/bayfind-demo-data` and the red message is expected, because the free size has no disk. Leave `DATA_DIR` as it is there.)

**Chat assistant.** It says how the chat window answers drivers: with built-in answers only, or with an AI as well. There is nothing to do here until you add the AI key (see “Optional extra” after step 9).

## Step 5. Your own web address (domain)

The `onrender.com` address works, but give drivers and Razorpay an address of your own. It looks more trustworthy, and it stays the same if you ever move the site. (Razorpay's own page does not say whether it insists on your own domain. Use one; it is the safer choice.)

**Buy a name.** Buy one from any domain seller (Namecheap, GoDaddy, Hostinger, BigRock and many others). A `.in` or `.com` name usually costs between ₹500 and ₹1,500 a year. You can use the main name (`yourname.in`) or a sub-name (`parking.yourname.in`). Turn on two-step login at the seller: whoever controls your domain controls your website.

**Tell Render.**

1. In Render open your service `parking-site`, then **Settings**. Scroll to **Custom Domains** and press **+ Add Custom Domain**.
2. Type your name, for example `parking.yourname.in`, and press **Save**. (Adding a name with `www.` in front also adds the plain name, and the other way round; one redirects to the other.)
3. Render shows the DNS records to add. At your domain seller open the **DNS** settings and add them **exactly as Render shows them**. Usually a sub-name gets a **CNAME** record pointing at your `onrender.com` address. A plain name such as `yourname.in` gets a record type that depends on your seller; Render's page for your seller says which.
4. **Delete any `AAAA` record** for the same name (Render uses IPv4 only, and an `AAAA` record can send visitors astray). Also delete a "parked page" record that the seller may have added.
5. If you use **Cloudflare**, set the records to **DNS only** (the grey cloud, not orange).
6. Back in Render press **Verify** next to the name. If it says it cannot verify yet, wait ten minutes and press it again. It can take up to an hour.

Render then gets the padlock for the name by itself and keeps it renewed, and it sends every plain `http://` visitor to `https://`.

**Check:** `https://parking.yourname.in/healthz` shows `{"ok":true}`, and the site shows a padlock.

## Step 6. Tell Razorpay about your website (the webhook)

A **webhook** is a message Razorpay sends your site the moment a payment succeeds (see "How a payment is checked", point 5). Set it up now, in test mode.

1. Open the Razorpay Dashboard and make sure it is in **Test Mode**.
2. Open **Account & Settings**, and under *Website and app settings* choose **Webhooks**, then **+ Add New Webhook**.
3. **Webhook URL:** `https://parking.yourname.in/api/razorpay/webhook` (your own domain).
4. **Secret:** the webhook secret from step 1.5. It must be the same text you typed in Render's `RAZORPAY_WEBHOOK_SECRET`.
5. **Alert Email:** your own email address. Razorpay writes to it when the webhook keeps failing.
6. **Active Events:** tick **payment.captured** and **order.paid**.
7. Press **Create Webhook**. In test mode Razorpay asks for a one-time code: type `754081`, which is the fixed code Razorpay's own page gives for test mode.

Razorpay keeps test mode and live mode apart, so you add a second webhook for live mode in step 8. Razorpay expects an answer within 5 seconds and tries again for up to 24 hours if it does not get one. If your site is down for more than a day, Razorpay switches the webhook off and emails you; switch it back on in the same page.

## Step 7. Test everything with test payments

1. On your phone, open your website. Press **Book a bay**.
2. Choose a vehicle, type a vehicle number such as `MP 09 AB 1234`, a time, and a bay. Press pay.
3. When the Razorpay window opens, pay with a **test card**:
   - Visa `4111 1111 1111 1111` or Mastercard `5267 3181 8797 5449`
   - any expiry date in the future, any 3-digit CVV, any name
   - if a test bank page appears, choose **Success**
4. You should see a confirmation with the bay and a booking reference. Open **Find my booking**, type the vehicle number, and check that the booking is there.
5. Open `https://parking.yourname.in/dashboard` and sign in. You should see your test booking and the payment.
6. **Check that the bookings survive a restart.** In Render open your service, open the **Manual Deploy** menu and choose **Restart service**. When the service is **Live** again, reload the dashboard: the booking is still there. Run the **Setup check** once more: *Bookings in it* is the same number as before, and *Site running for* says less than 2 minutes. That proves the disk works. If the booking is gone, go back to step 4 and read the "Where bookings are saved" part.
7. On the dashboard find **Cancel and refund a booking**, type the same vehicle number, and cancel it. In test mode this sends the test payment back. It also frees the vehicle number for the next test.
8. In the Razorpay Dashboard look at your webhook's own page for the list of the calls it made. Razorpay's screens change, so the place may differ a little. The calls should show as delivered. (If one shows as failed, see the table in step 9.)
9. Read the other pages: **Pricing, Terms, Privacy, Cancellation and refunds, Shipping and delivery, Contact** (the links at the bottom of every page). Step 8 explains why they matter.

**Check:** a test payment gives a confirmation; the booking is on the dashboard; it is still there after a restart; the cancel sends the refund.

## Step 8. Go live with real payments

Do this only when step 7 worked. Nothing here is rushed: the site can stay in test mode for as long as you like.

### 8a. Let Razorpay approve your business

In the Razorpay Dashboard complete the **account activation**: the business details, your bank account for payouts, and the verification documents it asks for. What it asks for depends on the kind of business (an individual or sole proprietor, a partnership, a company), so follow its form. Razorpay has to approve it before it gives you **live** keys.

Razorpay also checks your **website**. Its own page, [Business Website Details](https://razorpay.com/docs/payments/dashboard/account-settings/business-website-details/), says that you must give your live website during activation, that instant checks look at the site and its policy pages, and that without this you cannot use live keys. Give it your own domain, and the addresses of the six pages (this site has all of them):

```
https://parking.yourname.in/pricing
https://parking.yourname.in/terms
https://parking.yourname.in/privacy
https://parking.yourname.in/refunds
https://parking.yourname.in/shipping
https://parking.yourname.in/contact
```

Razorpay says it verifies the website within about 3 working days. The activation as a whole also depends on checks by its banking partners, so plan for several days. It may ask for a **sample invoice** (a picture of what a customer receives): a screenshot of a test booking confirmation is a reasonable thing to offer. If the policy pages are not accepted, Razorpay can also create pages for you during activation.

### 8b. Read the policy pages, and make them true

The six pages are written in plain language to match how this website really works. They are **starting points, not legal advice**. Before you take real money:

- Read every page once, slowly, on the live site.
- **Make the cancellation rule on `/refunds` match what you will really do.** It says: a full refund if the customer asks before the booking starts, and normally no refund after it has started. Change it if your rule is different, and keep your actions in line with the words.
- The pages say nothing about who is responsible for a vehicle or what is left in it, and nothing about GST. Ask a lawyer or your accountant whether you need to add that. Also ask whether GST applies to your parking and, if it does, how it has to be shown to customers and included in your prices.
- Have a lawyer or accountant look at all six pages if you can.

To change the words, open the page's file on GitHub: in your repository open the folder `public`, then `legal`, open the file (for example `refunds.html`), press the **pencil** icon, change the text, and press **Commit changes**. The files are plain HTML. Five of the pages show a **Last updated** date, in a line that starts with `<p class="updated">`: change it when you change the words. Then press **Deploy** in Render, as step 9 describes.

### 8c. Switch to your live keys

When Razorpay has approved you:

1. In the Razorpay Dashboard switch to **Live Mode**, open **Account & Settings → API Keys** and press **Generate Key**. Copy the **Key Id** (`rzp_live_…`) and the **Key Secret** into your note. (Razorpay allows live keys only once your website has been verified.)
2. Open **Account & Settings → Payments and refunds → Capture and refund settings**. Keep it on **Auto-capture all payments**, which is Razorpay's default. With manual capture a driver could end up with a booking whose payment is never collected: Razorpay refunds payments that are not captured within 3 days.
3. Still in **Live Mode**, add a **live webhook**: repeat step 6, with the same address, a **new** webhook secret (make up another long random text), the same two events, and your email as the alert address. You can leave the test webhook where it is, or delete it; it only ever hears about test payments.
4. In Render open your service, then **Environment**, and change these three:

   | Setting | New value |
   |---|---|
   | `RAZORPAY_KEY_ID` | the **live** Key Id, `rzp_live_…` |
   | `RAZORPAY_KEY_SECRET` | the **live** Key Secret |
   | `RAZORPAY_WEBHOOK_SECRET` | the new secret from item 3 |

   Check that the business details you typed in step 3 are right (`BUSINESS_NAME`, `SUPPORT_PHONE`, `BUSINESS_ADDRESS`, `SUPPORT_EMAIL`): the live site shows them on the Contact, Terms and Privacy pages. **Do not add a `DATA_DIR` setting.** Open the save menu and choose **Save and deploy**. Render starts the site again with the new values.

When the site restarts with live keys, it moves **by itself** to a fresh, empty folder on the disk, `/var/data/live`. Your test bookings stay safely in `/var/data/test`, and they can no longer block a real bay.

**Check:** the **Test mode** strip is gone from the site. The log says `Payments    LIVE: real Razorpay payments, real money` and `Bookings    saved in /var/data/live`. The dashboard's Setup check shows the folder `/var/data/live`, on the Render disk, with 0 bookings.

### 8d. Make one real payment

Book the cheapest slot (with the standard prices, a two-wheeler for 1 hour is ₹20 on a weekday and ₹30 on a weekend) and pay for it for real, from your own phone. Your bank asks you for its real check, such as the one-time code. Then check:

- the payment shows in the Razorpay Dashboard (**Live Mode**, under Transactions);
- the booking shows on `/dashboard`;
- your **live** webhook's page in Razorpay shows a delivered call.

Then cancel it from the dashboard with **Cancel and refund a booking**. That sends the money back and frees the bay. Razorpay shows the refund, and the money reaches your card or bank account within several working days. The cancelled booking stays in the list as "Cancelled, refunded". It does not count in the day's money figures and it does not block the bay.

Now tell your drivers the address.

**Do not switch the live site back to test keys.** The site would then show the *test* folder, and your live bookings would seem to vanish until you switch again (they stay safe in `/var/data/live`). To try a change, test it on your own computer first (see `README.md`, sections 1 and 2), then put it on the live site.

## Step 9. Everyday care

### Is everything healthy?

- In Render, the service page shows whether it is **Live**, and **Logs** shows what the site is saying. The site does not write your keys or passwords to its log. It does mention vehicle numbers and booking references, so do not paste the log in public.
- On the dashboard, **Setup check** shows the folder, the number of bookings in it, and how long the site has been running.
- **Get a message when the site goes down.** Many uptime-monitoring services have a free plan (UptimeRobot and Better Stack are two; check their terms for business use). Point one at `https://parking.yourname.in/healthz`. It answers `{"ok":true}` while the site is up.

### Update the site with a new version

1. Put the changed files on GitHub: open your repository, press **Add file → Upload files**, drag in the new files (a file with the same name replaces the old one), and press **Commit changes**. Or press the **pencil** on one file to change it there.
2. In Render open your service, open the **Manual Deploy** menu and choose **Deploy latest commit**.

The site is unavailable for a few seconds while the old version stops and the new one starts, and the build takes a few minutes before that (the old version keeps running during the build). Your bookings, settings and passwords are not touched. If the **build** fails, Render keeps the old version running and says so in the log.

I set `autoDeployTrigger` to `"off"` in `render.yaml` on purpose: nothing on a site that takes money should change until you press the button. If you would rather have every upload go live by itself, change `"off"` to `commit` in `render.yaml` (pencil icon on GitHub, then Commit); Render applies a change to `render.yaml` by itself.

**If a new version misbehaves**, go back. In Render open the service's **Deploys** page, find the last good deploy, and press **Rollback**, then confirm. Render puts that version back. Your bookings are not touched, because the disk is never rolled back.

### Change a price, the site name or another setting

Settings live in Render, not in files. Open your service, choose **Environment**, press **+ Add Environment Variable** (or change the one that is there), and choose **Save and deploy**. Render starts the site again with the change. The settings you can use are in the table in section 4 of `README.md`: the rates (`RATE_CAR_WEEKDAY` and so on), the weekend days, how long a bay is held, and more. Type each value without quotes. To change the dashboard password, change `OPERATOR_PASSWORD`.

### Backups

- Render copies the disk **once every 24 hours** and keeps each copy for **7 days**. To use one, open your service's **Disk** page and choose a snapshot to restore. Restoring puts the whole disk back as it was at that moment, so every booking made **after** that moment is gone from the file. The payments are still in your Razorpay Dashboard, so compare the two before you restore.
- The **Razorpay Dashboard** keeps the full record of every payment and refund, and can export it. It is the record to use for your accounts.
- If you want a copy of your own, Render lets you reach a disk with SSH and copy files with SCP (see [Render's page on disks](https://render.com/docs/disks)). That needs some comfort with the command window; ask someone who has done it.
- The disk can be made bigger later but never smaller. 1 GB holds far more bookings than this lot will ever have.

### Keep your keys safe

- Turn on two-step login at **GitHub, Render, Razorpay and your domain seller** (and **Anthropic**, if you use the AI chat answers).
- If a key or password is ever shown to someone who should not see it, change it. For a Razorpay key: **Account & Settings → API Keys → Generate new key** (Razorpay asks for a one-time code), put the new one in Render, and then deactivate the old one in Razorpay. Razorpay lets you do that straight away or within 24 hours. For the dashboard password: change `OPERATOR_PASSWORD`. For an Anthropic key: delete it on <https://platform.claude.com/settings/keys>, make a new one and put it in `ANTHROPIC_API_KEY`.
- Anyone who can open your Render account can read the keys. Do not give Render access to people who should not have it.

### If something breaks

| What you see | What to do |
|---|---|
| Render says the build failed, and the log mentions `package-lock.json` | The file `package-lock.json` is missing from your repository. Upload it (step 2). |
| Render says the build failed and names a Node version | Render no longer offers the version in `NODE_VERSION`. In `render.yaml` on GitHub change `24.22.1` to a newer 24 number, commit, and deploy again. |
| Render says it does not know the size `0.5c-512mb` | In `render.yaml` on GitHub change `0.5c-512mb` to `starter`, commit, and press **Deploy Blueprint** again. |
| Render refuses the free demo and mentions the region | On GitHub change `singapore` to `frankfurt` (or `oregon`) in `render.yaml` on the branch `free-demo` (or in `render-free.yaml`, if you made the demo with **New**, then **Blueprint**), commit, and press **Deploy Blueprint** again. |
| Render asks for a card before it creates the free demo | Render sometimes does this for verification, even for free services (see “A free demo first”). It is a temporary $1 hold that is reversed straight away. If you have no card that works for online payments in US dollars, Render will not create the service, and the demo cannot be put on Render. |
| You cannot sign in to the free demo's dashboard | The user name is `operator`. The password is the value of `OPERATOR_PASSWORD` under **Environment** in Render (see “A free demo first”). To choose your own, press **Edit** next to it, type it, and choose **Save and deploy**. |
| I want the chat to answer any question | Make a free key at aistudio.google.com (Gemini) or console.groq.com (Groq). In Render open your service, **Environment**, **Add Environment Variable**: name `AI_API_KEY`, value your key (type it only there), and optionally `AI_PROVIDER` with `groq`. Then **Save and deploy**. The chat window then shows an AI greeting. |
| Booking asks you to sign in | Customers sign in (or create an account) before booking. On the free test site use the test customer shown on the sign-in page, or create your own account. To let anyone book without an account, add `CUSTOMER_LOGIN_REQUIRED` with the value `off` under Environment. |
| How do I sign in as the admin? | Open `/login`, type `operator` and the value of `OPERATOR_PASSWORD` (Render, your service, **Environment**; you can change it to a password you can remember, then **Save and deploy**). The admin sees **Dashboard** and **Analytics** in the menu. |
| My account or my bookings disappeared | The free size forgets every file when it sleeps, restarts or is updated, so accounts, bookings and analytics are cleared too. The admin login and the test customer always come back. Open the site a few minutes before you present it, and use **Add sample bookings** on the Analytics page to fill the charts. The paid size with a disk keeps everything. |
| The free test site still says “payments are simulated” after you added Razorpay keys | Both `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are needed, each typed without quotes or spaces, and then **Save and deploy**. The strip says **Test mode** once Razorpay's keys are in. |
| The free demo takes a minute to open, or the first payment is slow | The free size goes to sleep after 15 minutes without visitors, and waking it takes about a minute. Open the address once, wait, then try again. The real site on the paid size does not sleep. |
| The deploy fails with "no open port" or the service keeps restarting | Open **Logs** and read the first red line. A missing or wrong setting is the usual cause. |
| The pages show "Online booking is switched off" | The Razorpay keys are missing or empty in **Environment**. Both `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are needed. |
| The dashboard says it is "switched off until OPERATOR_PASSWORD is set" | Set `OPERATOR_PASSWORD` in **Environment**. |
| The Razorpay window says authentication failed, or the log says "Authentication failed" | A test key is mixed with a live key, or the Key Id and Key Secret do not belong together. Generate the pair again and paste both again. |
| The Razorpay window does not open, or is blank | Press **F12**, open the **Console** tab and look for a message that starts with "Refused to …". The browser's security rules blocked something Razorpay needs. Add `DISABLE_CSP` = `1` in **Environment** (and **Save and deploy**) to confirm that this is the cause, then ask whoever helps you to add the blocked address to the policy in `src/app.js` (the function `securityHeaders`) and remove `DISABLE_CSP` again, because leaving it on removes a protection. |
| The webhook calls show as failed in Razorpay | The site answers 404 when `RAZORPAY_WEBHOOK_SECRET` is empty and 400 when the secret does not match. Make sure the secret is the same text in Render and in Razorpay's webhook page, and that you are looking at the right mode: **test** webhooks go with test keys and **live** webhooks with live keys. A call that came while the site was updating is tried again by Razorpay by itself. |
| A driver paid but has no booking | Wait a few minutes: the site re-checks unconfirmed payments about a minute after the hold ends. If there is still none, refund the payment in the Razorpay Dashboard. |
| The dashboard says "Refund needed" | The message says why. Fix that, then press **Retry refund**. If the message says that the server restarted while the refund was being sent, just press **Retry refund**. That is safe: Razorpay refuses to refund the same payment in full twice, so if the first try did go through, the site finds that out, marks the booking as refunded, and nothing more is sent. |
| The bookings disappeared after an update or a restart | On the **free demo** this is normal: that size keeps no files. On the real site, open the dashboard's **Setup check**. If it says the bookings are not on the Render disk, delete the `DATA_DIR` setting in **Environment**. If you changed keys, remember that test and live bookings are in different folders (see step 8c). Otherwise restore a disk snapshot (step 9, Backups). |
| Visitors see "Too many searches" or "Too many booking attempts" | `TRUST_PROXY` is probably too low. Run the **Setup check** (step 4). |
| The chat window is gone, or has no **Ask us** button | `CHAT_ENABLED` is set to `off`. Delete it in **Environment** and choose **Save and deploy**. The dashboard never has the button. |
| You added `ANTHROPIC_API_KEY` but the chat still says “Instant answers”, or the Setup check says “The AI is not answering” | Run the **Setup check** (step 4): its **Chat assistant** part says why. The usual causes: the key was copied in part or has a space or quotes around it (401); there is no credit or a payment problem on Anthropic's Billing page (402); `CHAT_MODEL` names a model that does not exist (404); a spend or rate limit on the Anthropic account was reached (429). Nothing is lost meanwhile: drivers get the built-in answers. Once the cause is fixed, the next question is answered by the AI again (a changed setting in **Environment** needs **Save and deploy**). |
| The custom domain will not verify, or the browser says the connection is not private | The DNS records are not as Render shows them, or an `AAAA` record is still there, or Cloudflare is on orange. Fix them (step 5), wait ten minutes, and press **Verify** again. |
| The site does not answer for a minute after you pressed Deploy | That is normal: the old version stops before the new one starts (see "What to know before you start"). |

## Optional extra: let an AI answer in the chat

Every public page has a yellow **Ask us** button that opens a chat window. **It already works, with no setup and no cost**: it answers from your own prices, hold time and contact details and from the live count of free bays. This extra lets Anthropic's Claude AI write the answers instead, so drivers can ask in their own words and language. It cannot book, cancel or refund anything and it never sees a booking. If the AI is ever unavailable, drivers get the built-in answers and nothing breaks. `README.md`, section 3, “The chat assistant”, says more.

**It costs a little, on a separate bill.** Anthropic charges your own Anthropic account for each answer, in US dollars. At the price Anthropic lists for the model the site uses (`claude-haiku-5-5`: $0.10 per million input tokens and $0.50 per million output tokens, see its [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)), an ordinary answer is a small fraction of one US cent. That is an estimate, so look at the pricing page and at the usage on your own Anthropic account. The site gives at most 500 AI answers a day (the setting `CHAT_DAILY_LIMIT`), which at the very most is a few US dollars a day, and step 3 below puts a spending cap of your own on Anthropic's side as well.

**With the AI on, what a driver types in the chat is sent to Anthropic.** The site's `/privacy` page says so by itself as soon as the key is in. The site does not keep the chat and does not write it to its log.

1. **Make an Anthropic account** at <https://platform.claude.com> (the Anthropic Console). It is separate from a Claude chat subscription. Confirm your email if it asks.
2. **Add credit.** Open **Billing** (<https://platform.claude.com/settings/billing>) and add a card or credit. As with Render, switch on international online payments for that card in your bank's app first.
3. **Set a spending cap (recommended).** Open **Workspaces** (<https://platform.claude.com/settings/workspaces>), create a workspace called `parking-site`, open it, and set a monthly **spend limit** you are comfortable with (and an alert, if it offers one). The Default Workspace cannot have a limit, which is why a workspace of its own is worth a minute.
4. **Create the key.** Open **API keys** (<https://platform.claude.com/settings/keys>) and press **Create key**. Name it `parking-site` and choose that workspace. **Copy the key at once**: it starts with `sk-ant-` and is shown only one time. Keep it as private as the Razorpay Key Secret.
5. **Put the key in Render.** Open your service, choose **Environment**, press **+ Add Environment Variable**, type `ANTHROPIC_API_KEY` as the name and paste the key as the value, with no quotes and no spaces around it. Then open the save menu and choose **Save and deploy**. Render starts the site again with the key, which takes about a minute.
6. **Check that it works.**
   - Open the service's **Logs**. You should see a line like `Chat        AI assistant (claude-haiku-5-5): up to 500 AI answers a day, instant answers after that.` A line that says `Instant answers, no AI` means the key did not arrive: look at the name and the value in **Environment**. A `Note` line that says the key does not look like an Anthropic key means it was copied in part.
   - Open your site, press **Ask us** and ask something, for example “What does parking cost on a Sunday?” The header of the chat window says **AI assistant** when the site has a key and **Instant answers** when it has not. (It tells what the site is set up to do; the next check tells whether the AI really answered.)
   - Open `/dashboard`, scroll to **Setup check** and press **Run the check**. The **Chat assistant** part says how drivers are being answered, how many questions were sent to the AI today and, if the AI is not answering, why: a key that Anthropic refused, no credit left, a model name that does not exist, or a limit that was reached.

**Other settings** (all optional, added in the same Environment page, each followed by **Save and deploy**):

| Name | What it does |
|---|---|
| `CHAT_DAILY_LIMIT` | The most AI answers the whole site gives in a day (500 if you set nothing). Past it, drivers get the built-in answers until the next day. `0` stops the AI and keeps the key. |
| `CHAT_MODEL` | Another AI model. Leave it empty for the default, `claude-haiku-5-5`, the small, fast and cheap one. A wrong name makes the AI fail (the Setup check says so), and a bigger model costs much more per answer. |
| `CHAT_ENABLED` | Set to `off` to hide the chat window on every page. |

The key is not listed in `render.yaml` on purpose: the chat works without it, so the first deploy does not ask for it.

**To stop the AI answers**, delete `ANTHROPIC_API_KEY` in **Environment** and choose **Save and deploy** (or set `CHAT_DAILY_LIMIT` to `0`). To stop the billing for good, also delete the key on Anthropic's keys page.

## What is where

For the person who looks after it:

| Where | What |
|---|---|
| GitHub: your private repository | The site's files. Render builds from here. |
| Render: the service `parking-site` | The running site. Its settings are under **Environment**; its log is under **Logs**. |
| Render: the disk `parking-data`, mounted at `/var/data` | The only place that keeps files. `/var/data/test` holds bookings made with test keys and `/var/data/live` those made with live keys. Each has one file, `bookings.json`. |
| `render.yaml` | Tells Render what to build. Secrets are never in it: the boxes marked `sync: false` are typed into Render. |
| `render-free.yaml` | The free demo. It has no boxes: Render makes up the admin password itself, and booking stays off until Razorpay's test keys are added under **Environment**. (On the branch `free-demo` the same file is named `render.yaml`, so that one link can start it.) |
| Render: **Environment** | Your keys, passwords and details (including `ANTHROPIC_API_KEY`, if you use the AI chat answers). Settings that the site chooses itself on Render (`TRUST_PROXY`, `DATA_DIR`, `PORT`) are left out on purpose; add one only if you need to override the choice. |
| Razorpay: **Webhooks** | One webhook in test mode and one in live mode, both pointing at `/api/razorpay/webhook`. |
| Anthropic Console (optional) | The AI key, the credit and the spending cap for the chat's AI answers: **API keys**, **Billing** and **Workspaces**. |

## Words used in this guide

- **Render:** the company that runs your website for you.
- **GitHub / repository:** a website that stores folders of files. A repository is one such folder.
- **Blueprint:** the file `render.yaml`, a list that tells Render what to create.
- **Disk:** the part of Render that keeps files when the site restarts or is updated. Everything outside it is wiped.
- **Domain name:** the address people type, like `parking.yourname.in`.
- **DNS record:** an entry in the internet's phone book. A CNAME record says "this name is another name for that name".
- **HTTPS / padlock:** the safe, encrypted way a browser talks to a website.
- **Webhook:** a message Razorpay sends your site when something happens, for example a payment.
- **Signature:** a code that proves a message was made by someone who knows a secret, without showing the secret.
- **Test mode / live mode:** Razorpay keeps two separate worlds. In test mode nothing real is charged. In live mode real money moves.
- **Snapshot:** a copy of the whole disk, made by Render once a day.
- **API key (Anthropic):** a long secret text that lets your site ask Anthropic's AI for an answer, and makes Anthropic bill your account for it.

## Where the facts in this guide come from

Render: [Blueprint file reference](https://render.com/docs/blueprint-spec), [Persistent disks](https://render.com/docs/disks), [Deploys](https://render.com/docs/deploys), [Rollbacks](https://render.com/docs/rollbacks), [Custom domains](https://render.com/docs/custom-domains), [Health checks](https://render.com/docs/health-checks), [Pricing](https://render.com/pricing), [Free instances](https://render.com/docs/free), [Regions](https://render.com/docs/regions), and Render Support's answers on card checks for free services ([one](https://community.render.com/t/free-but-credit-card-first/24630), [two](https://community.render.com/t/web-service-free-tier-credit-card/33811)). Razorpay: [Webhooks](https://razorpay.com/docs/webhooks/setup-edit-payments/), [API keys](https://razorpay.com/docs/payments/dashboard/settings/api-keys/), [Business website details](https://razorpay.com/docs/payments/dashboard/account-settings/business-website-details/), [Capture and refund settings](https://razorpay.com/docs/payments/dashboard/account-settings/capture-refund/). Anthropic (the optional AI chat): [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), and the Console pages for [API keys](https://platform.claude.com/settings/keys), [Billing](https://platform.claude.com/settings/billing) and [Workspaces](https://platform.claude.com/settings/workspaces). Screens and prices change; if a screen looks different from this guide, the idea is the same.
