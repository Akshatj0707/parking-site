# Putting your parking website online

This guide takes you from the zip file on your computer to a real website with its own address, for example `https://parking.yourname.in`, that drivers can use to book and pay. You do not need to know how servers work. You copy a few commands, and one script does the technical part.

**Would you rather not look after a server at all?** `DEPLOY-RENDER.md` is the same journey on Render (render.com), which runs the site for you for about $7.25 a month. Use one guide or the other.

**How long it takes:** about 1 to 2 hours the first time, most of it waiting (for the domain to start working, and for the server to install things). Going live with real money takes longer, because Razorpay has to approve your business first (step 10).

**If someone else will do this for you:** give them the zip, this guide, and the logins for your domain and your Razorpay account. Steps 4 to 8 are about an hour of work for anyone who has used a server before.

## What you will end up with

```
A driver's phone  --->  your domain  --->  Caddy (web server: HTTPS, redirects)  --->  your parking site  --->  bookings.json
  https://parking.yourname.in               gets and renews the padlock by itself         runs by itself            saved on the server,
                                                                                          after a crash or reboot   copied every night
```

- **HTTPS (the padlock)** is set up and renewed automatically. It is free.
- The site **starts by itself** after a crash or after the server restarts.
- A **copy of your bookings is made every night** and kept for 30 days.
- Only three doors are open on the server: SSH (for you), and ports 80 and 443 (for visitors).
- **Updating** the site later is quick: upload the new zip and run one script. If the new version does not start, the old one is put back by itself.

## The steps at a glance

| # | What you do | Time |
|---|---|---|
| 1 | Get ready: what you need | 15 min |
| 2 | Choose a server company | 10 min |
| 3 | Buy a domain name | 10 min |
| 4 | Create the server | 10 min |
| 5 | Point the domain at the server | 5 min, then wait up to an hour |
| 6 | Upload the site | 5 min |
| 7 | Run the setup script | 10 min |
| 8 | Tell Razorpay about your website (the webhook) | 5 min |
| 9 | Test everything with test payments | 20 min |
| 10 | Go live with real payments | a few days (Razorpay checks your business) |
| 11 | Everyday care: updates, backups, if something breaks | as needed |
| Extra | Let an AI answer in the chat (optional) | 15 min |

---

## Step 1. Get ready

You need:

1. **This zip file** (`bayfind-smart-parking.zip`), saved on your computer.
2. **A Windows or Mac computer** and a few minutes with its command window. Windows 10 and 11 normally already have the tools you need; step 4 shows how to check.
3. **A bank card** that your server company accepts. Most accept international debit and credit cards: in your bank's app, switch on international online payments for the card first. Some Indian companies accept UPI.
4. **A free Razorpay account** with **test keys**, so you can try everything without real money:
   1. Create an account at <https://razorpay.com> and log in.
   2. Switch the toggle at the top of the Razorpay Dashboard to **Test Mode**.
   3. Open **Account & Settings → API Keys** (under *Website and app settings*) and press **Generate Key**.
   4. Copy the **Key Id** (starts with `rzp_test_`) and the **Key Secret**. The Dashboard does not show the secret again afterwards, so paste both into a note on your computer right away.
5. **A name for your business** and, if you like, an **email address** for customers. Both appear on the website.

Keep the Key Secret private. Do not paste it into a chat, an email or a web page. The setup script asks for it later, and it is stored on your server where only the administrator can read it.

> **Never done this before?** You do not have to understand each command. Copy each one exactly, press Enter, and compare what you see with what this guide says you should see. Every step says what to check before you go on.

## Step 2. Choose a server company

A **server** is a computer in a data centre that stays on all the time. Your website runs on it. You rent one by the month.

**What to ask for:** a **VPS** or **cloud server** (some companies say "droplet", "instance" or "Lightsail") with:

- **Ubuntu 24.04 LTS** as the operating system. (Ubuntu 22.04, and Debian 12, also work. Choose "Ubuntu" or "plain Linux", not "WordPress", "cPanel" or any other ready-made package.)
- **1 GB of memory** is enough. 1 CPU, 25 GB of disk, all fine. A bigger server brings nothing for a lot of this size.
- **A public IPv4 address.** Some companies sell cheaper "IPv6 only" plans. Do not choose those: many phones and networks cannot reach them.
- **A location in India** (Mumbai, Bangalore or Delhi) so that the site is quick for your drivers.

Examples, with the prices on the companies' own pages on 23 October 2026. Prices change, so check before you buy:

| Company | Plan | Price | India location | Good to know |
|---|---|---|---|---|
| [DigitalOcean](https://www.digitalocean.com/pricing/droplets) | Basic Droplet, 1 GB | $6 a month | Bangalore | Simple screens. Needs a credit or debit card that is switched on for international payments (prepaid and virtual cards are refused). **A good first choice.** |
| [Amazon Lightsail](https://aws.amazon.com/lightsail/pricing) | Linux, 1 GB, with IPv4 | $7 a month | Mumbai | Needs a card. Its own firewall may not allow HTTPS at first (step 4 says how to open it). |
| [Hostinger India](https://www.hostinger.com/in/vps-hosting) | KVM 1 | ₹599 a month at the start (₹999 on renewal), without GST | India is on its list of VPS locations | Billed in rupees; its page lists UPI. **You pay for the whole plan period up front**, so the first bill covers many months at once. Its smallest plan is bigger than you need. |

Roughly: **₹500 to ₹700 a month** for the server. Any company that sells a plain Ubuntu server with a root login works; the script does not care which one.

## Step 3. Buy a domain name

A **domain name** is the web address people type, for example `parking.yourname.in`. Buy one from any domain seller (Namecheap, GoDaddy, Hostinger, BigRock and many others). A `.in` or `.com` name usually costs between ₹500 and ₹1,500 a year. Pick something short that drivers can spell.

You can use the main name (`yourname.in`) or a sub-name (`parking.yourname.in`). Both work the same way.

Turn on two-step login (2-factor) at the domain seller. Whoever controls your domain controls your website.

## Step 4. Create the server

On the server company's website, create a server with the choices from step 2. On DigitalOcean it looks like this:

1. **Create → Droplets.**
2. **Region:** Bangalore.
3. **Image:** Ubuntu 24.04 (LTS) x64.
4. **Size:** Basic, Regular, **$6 a month** (1 GB / 1 CPU / 25 GB).
5. **How you will log in:** see just below.
6. **Hostname:** `parking` (anything works).
7. Press **Create**. After a minute the server has an **IP address**, four numbers with dots, like `143.110.200.15`. Write it down. This guide calls it **SERVER_IP**.

**How you will log in: an SSH key, or a password.**

*An SSH key (safer, and not hard).* It is like a very long password that stays on your computer. Open your command window (**Windows:** press the Windows key, type `PowerShell`, press Enter. **Mac:** press Cmd+Space, type `Terminal`, press Enter) and type:

```
ssh-keygen -t ed25519
```

Press Enter at every question (the default place, and no passphrase, are fine). Then show the public half of the key:

```
Get-Content $HOME\.ssh\id_ed25519.pub        (Windows PowerShell)
cat ~/.ssh/id_ed25519.pub                    (Mac)
```

Copy the line that starts with `ssh-ed25519`, and paste it into the **SSH key** box on the server company's page. Never share the *other* file, `id_ed25519` (without `.pub`).

If PowerShell says that `ssh-keygen` is not recognized: press Start, type **Optional features**, open it, choose **Add a feature**, pick **OpenSSH Client**, install it, and try again.

*A password (easier, less safe).* Choose "Password" and use a **long, random** one (20 or more letters and digits, from a password manager). Servers on the internet get password guesses all day long.

**Open the doors (only if your company has its own firewall).** Some companies close all ports until you open them. Look for **Firewall**, **Networking** or **Security group** on the server's page, and allow incoming **TCP** on ports **22** (SSH), **80** (HTTP) and **443** (HTTPS). Allowing **443 UDP** as well makes the site a little faster, but it is optional. On Lightsail this is **Networking → IPv4 Firewall**, and 443 is not open until you add it. DigitalOcean has no firewall until you make one.

Check that you can reach the server. In your command window:

```
ssh root@SERVER_IP
```

(replace SERVER_IP with your number; use the login name your company gave, `root` on most, `ubuntu` on Lightsail). The first time it asks `Are you sure you want to continue connecting?`. Type `yes` and press Enter. You should now see a line ending in `#` or `$`: you are inside the server. Type `exit` and press Enter to come back to your own computer.

## Step 5. Point the domain at the server

This tells the internet that your domain name lives at your server's address.

1. At your domain seller, open the **DNS** settings for the domain (sometimes called "Manage DNS" or "DNS records").
2. **Delete** any existing **A** or **AAAA** record for the same name. (Sellers often add a "parked page" record that would send visitors elsewhere.)
3. **Add a record:** Type **A**, Name (or Host) **@** (or the sub-name, for example `parking`), Value **SERVER_IP**. Leave the TTL on automatic.
4. **Add a second record:** Type **A**, Name **www**, Value **SERVER_IP** (for `parking.yourname.in` use `www.parking`). With this, `www.` visitors are sent to your main address automatically.
5. If you use **Cloudflare**, set both records to **DNS only** (the grey cloud, not orange).

Wait a few minutes, then check. **Windows** (PowerShell) or **Mac**:

```
nslookup yourname.in
```

The answer should show your SERVER_IP. If it shows something else or an error, wait ten minutes and ask again. It can take up to an hour, rarely longer. You can carry on with step 6 while you wait.

## Step 6. Upload the site

In your command window, send the zip file to the server. Change `SERVER_IP` (and the login name if it is not `root`).

**Windows (PowerShell):**

```
scp "$HOME\Downloads\bayfind-smart-parking.zip" root@SERVER_IP:/root/
```

**Mac (Terminal):**

```
scp ~/Downloads/bayfind-smart-parking.zip root@SERVER_IP:/root/
```

If the zip is somewhere else, replace the path in quotes. If you log in as `ubuntu` (Lightsail), use `ubuntu@SERVER_IP:/home/ubuntu/`. If the company gave you a key file (`.pem`), add `-i "path\to\key.pem"` right after `scp`. You should see the file name and `100%`.

## Step 7. Run the setup script

Log in to the server:

```
ssh root@SERVER_IP
```

Then, on the server, one line at a time:

```
sudo apt-get update
sudo apt-get install -y unzip
unzip bayfind-smart-parking.zip
cd bayfind-smart-parking
sudo bash deploy/setup.sh
```

(`sudo` means "as the administrator". On Ubuntu it always works. On a plain Debian server where you are `root`, if it says `sudo: command not found`, leave the word `sudo` out. If you logged in as `ubuntu`, the zip is in `/home/ubuntu`, which is where you start.)

The script asks a few questions. Press **Enter** to accept what it offers:

| It asks | Answer |
|---|---|
| **Your website address** | Your domain, for example `parking.yourname.in`. Just the name: no `https://`, no spaces. |
| **The name of your parking business** | The name shown at the top of every page, up to 40 characters. |
| **An email address that customers can write to** | Your support email, or Enter to skip. |
| **Razorpay Key Id** | The **test** Key Id from step 1 (`rzp_test_…`). No keys yet? Press Enter: the site goes online with booking switched off, and you run the script again when you have them. |
| **Razorpay Key Secret** | Paste the test secret. **Nothing appears while you paste. That is normal.** Press Enter. |
| **A password for the operator dashboard** | Press Enter and the script makes a strong one for you. |
| **Go ahead?** | Press Enter (yes). |

Then it works for a few minutes: it installs Node.js and Caddy, puts the site in place, starts it, turns on the firewall and waits for the HTTPS padlock. On a brand-new server it may wait a few minutes at "Refreshing the list of available software" while the server installs its own updates. That is normal.

At the end you see something like this:

```
All done.

  Your site        https://parking.yourname.in
  Dashboard        https://parking.yourname.in/dashboard
                     user name   operator
                     password    Kq3xV9mT2bLw7RzYc4HnP8sD
                     Write this password down now. It is not shown again.
  Payments         TEST mode: nothing real is charged

  Razorpay webhook (add it once; DEPLOY.md, step 8)
    URL     https://parking.yourname.in/api/razorpay/webhook
    Secret  d3Yq...
    Events  payment.captured and order.paid

  Policy pages (Razorpay asks for these addresses when you apply for live payments)
    https://parking.yourname.in/pricing
    https://parking.yourname.in/terms
    https://parking.yourname.in/privacy
    https://parking.yourname.in/refunds
    https://parking.yourname.in/shipping
    https://parking.yourname.in/contact

  Handy commands
    sudo bash /opt/bayfind/deploy/check.sh        is everything healthy?
    sudo journalctl -u bayfind -f        watch the site's log (Ctrl+C to stop watching)
    sudo bash /opt/bayfind/deploy/setup.sh        change a setting, or install a new version
```

**Write down the dashboard password and the webhook secret now.** The script shows them only this once. (If you lose them: `sudo grep PASSWORD /etc/bayfind/bayfind.env` and `sudo grep WEBHOOK /etc/bayfind/bayfind.env` show them again, to anyone who can log in to the server as administrator.)

Open `https://parking.yourname.in` in your browser. You should see your site with the padlock and a yellow strip that says it is in test mode.

**If it says "HTTPS is not working yet"**, or the page does not open: nearly always the domain does not point at the server yet (step 5), or a port is closed at the server company (step 4). Fix that, wait ten minutes, and run the same script again: `sudo bash deploy/setup.sh` (press Enter at every question to keep your answers). It is safe to run it as many times as you like. To see what is wrong, run `sudo bash deploy/check.sh`. It lists what works and what does not, and says what to do about each problem.

If the connection to the server drops in the middle of the setup, log in again and run the same command again.

## Step 8. Tell Razorpay about your website (the webhook)

A **webhook** is a message Razorpay sends your site the moment a payment succeeds. Without it, a driver who pays and then closes the browser would be confirmed about a minute later instead of at once. It is a safety net, so set it up once.

1. Open the Razorpay Dashboard, and make sure it is in **Test Mode**.
2. Open **Account & Settings → Webhooks** (on some dashboards it is **Settings → Webhooks**) and choose **Add New Webhook**.
3. **Webhook URL:** `https://parking.yourname.in/api/razorpay/webhook` (your domain, as printed by the setup script).
4. **Secret:** the **webhook secret** from the end of the setup script.
5. Tick the events **payment.captured** and **order.paid**. Save.

Razorpay keeps test mode and live mode apart, so you will add a second webhook for live mode in step 10.

## Step 9. Test everything with test payments

1. On your phone, open your website. Press **Book a bay**.
2. Choose a vehicle, type a vehicle number such as `MP 09 AB 1234`, a time, and a bay. Press pay.
3. When the Razorpay window opens, pay with a **test card**:
   - Visa `4111 1111 1111 1111` or Mastercard `5267 3181 8797 5449`
   - any expiry date in the future, any 3-digit CVV, any name
   - if a test bank page appears, choose **Success**
4. You should see a confirmation with the bay and a booking reference. Open **Find my booking**, type the vehicle number, and check that the booking is there.
5. Open `https://parking.yourname.in/dashboard`. Sign in with the user name `operator` and the dashboard password. You should see your test booking and the payment.
6. On the dashboard, find **Cancel and refund a booking**, type the same vehicle number, and cancel it. In test mode this sends the test payment back. It also frees the vehicle number for the next test.
7. Look at the other pages: **Pricing, Terms, Privacy, Cancellation and refunds, Shipping and delivery, Contact** (the links at the bottom of every page). Read them. Step 10 explains why they matter.
8. On the server, run `sudo bash /opt/bayfind/deploy/check.sh`. Every line should start with **OK**. A line marked **CHECK** is worth a look; a line marked **PROBLEM** needs fixing, and the line says how.

If a test payment works, the webhook works too. You can also see the webhook calls in the Razorpay Dashboard, in the webhook's own page.

## Step 10. Go live with real payments

Do this only when step 9 worked. Nothing here is rushed: the site can stay in test mode for as long as you like.

### 10a. Let Razorpay approve your business

In the Razorpay Dashboard, complete the **account activation** (the business details, your bank account and the verification documents it asks for). Razorpay has to approve it before it gives you **live** keys.

Razorpay also checks your **website**. Its own page, [Business Website Details](https://razorpay.com/docs/payments/dashboard/account-settings/business-website-details/), says that you must give your live website during activation, that Razorpay runs checks on the site and its policy pages, and that without this you cannot use live keys on your site. It asks for the addresses of the pages below (the setup script prints them too):

```
https://parking.yourname.in/pricing
https://parking.yourname.in/terms
https://parking.yourname.in/privacy
https://parking.yourname.in/refunds
https://parking.yourname.in/shipping
https://parking.yourname.in/contact
```

Razorpay may also ask for a **sample invoice** (a picture or PDF of what a customer receives). A screenshot of a test booking confirmation is a reasonable thing to offer. Read what the form says, as the wording changes. If the policy pages are not accepted, Razorpay can also create pages for you during activation.

### 10b. Read the policy pages, and make them true

The six pages are written in plain language to match how this website really works. They are **starting points, not legal advice**. Before you take real money:

- Read every page once, slowly, on the live site.
- **Make the cancellation rule on `/refunds` match what you will really do.** It says: a full refund if the customer asks before the booking starts, and normally no refund after it has started. Change it if your rule is different, and keep your actions in line with the words.
- The pages say nothing about who is responsible for a vehicle or what is left in it, and nothing about GST. Ask a lawyer or your accountant whether you need to add that. Also ask whether GST applies to your parking and, if it does, how it has to be shown to customers and included in your prices.
- Have a lawyer or accountant look at all six pages if you can.

To change the wording, edit the files in the `public/legal` folder of **your own copy** (they are plain HTML; any text editor works). Five of the pages show a **Last updated** date, in a line that starts with `<p class="updated">`. When you change the words of a page, change its date too. Then make a new zip of the whole `bayfind-smart-parking` folder and update the site as step 11 describes. To make the zip, on **Windows** right-click the folder and choose **Send to → Compressed (zipped) folder**; on a **Mac** right-click it and choose **Compress**. Keep the folder name as it is. Changes made only on the server are overwritten by the next update.

### 10c. Switch the server to your live keys

When Razorpay has approved you:

1. In the Razorpay Dashboard switch to **Live Mode**, and open **Account & Settings → API Keys** and press **Generate Key**. Copy the Key Id (`rzp_live_…`) and the Key Secret.
2. Open **Account & Settings → Payments and refunds → Capture and refund settings** in the Dashboard and keep **Auto-capture all payments** (Razorpay's default). With manual capture, a driver could end up with a booking whose payment is never collected: Razorpay refunds payments that are not captured within 3 days.
3. On the server run the script again:

   ```
   sudo bash /opt/bayfind/deploy/setup.sh
   ```

   Press Enter to keep the answers you have. At the Key Id and Key Secret questions, paste the **live** ones. Because the keys are live, it now also asks for your **business name** (the name on your Razorpay account), a **phone number** and an **address**. They appear on the Contact, Terms and Privacy pages. The dashboard password stays as it was.
4. Add the **live webhook**: in the Razorpay Dashboard, in **Live Mode**, repeat step 8 with the same URL and **the same secret** (show it with `sudo grep WEBHOOK /etc/bayfind/bayfind.env`).

### 10d. Clear the test bookings

Test bookings would otherwise block real bays. On the server:

```
sudo systemctl stop bayfind
sudo rm -f /var/lib/bayfind/bookings.json
sudo systemctl start bayfind
```

### 10e. Make one real payment

Book the cheapest slot (a two-wheeler for 1 hour on a weekday is ₹20) and pay for real, from your own phone. Check that the payment shows in the Razorpay Dashboard (Live Mode) and on `/dashboard`. Then cancel it from the dashboard with **Cancel and refund**, which sends the money back and frees the bay. Then clear the bookings once more with the three commands of step 10d, so the lot starts clean.

Run `sudo bash /opt/bayfind/deploy/check.sh` again. It should say that payments are in **LIVE** mode and that your business details are set.

Now tell your drivers the address.

## Step 11. Everyday care

### Is everything healthy?

```
sudo bash /opt/bayfind/deploy/check.sh
```

It changes nothing, so it is safe at any time. It prints no secrets, so you can paste its whole output when you ask someone for help. `check.sh --logs` adds the latest lines of the site's log.

**Get a message when the site goes down.** Many uptime-monitoring services have a free plan (UptimeRobot and Better Stack are two; check their terms for business use). Point one at `https://parking.yourname.in/healthz`. It answers `{"ok":true}` while the site is up, and the service emails you when it does not.

### Update the site with a new version

On your own computer, send the new zip to the server (like step 6, with a different file name):

```
scp "$HOME\Downloads\bayfind-smart-parking.zip" root@SERVER_IP:/root/new-version.zip
```

Then on the server:

```
ssh root@SERVER_IP
unzip -o new-version.zip -d new-version
cd new-version/bayfind-smart-parking
sudo bash deploy/setup.sh --yes
```

`--yes` means "ask nothing and keep every setting". Your bookings, your settings and your passwords are not touched. The site is down for about a second. **If the new version does not start, the script puts the previous version back by itself** and says so. The previous version is always kept in `/opt/bayfind.prev`.

To go back by hand later:

```
sudo systemctl stop bayfind
sudo mv /opt/bayfind /opt/bayfind.bad
sudo mv /opt/bayfind.prev /opt/bayfind
sudo systemctl start bayfind
```

### Change a price, the site name or another setting

Prices and most other settings are lines in one file. Open it:

```
sudo nano /etc/bayfind/bayfind.env
```

Add or change a line, for example `RATE_CAR_WEEKDAY="45"`. Save with **Ctrl+O**, then Enter, and leave with **Ctrl+X**. Then restart the site so that it reads the change:

```
sudo systemctl restart bayfind
```

The settings you can use are in the table in section 4 of `README.md` (rates, weekend days, hold minutes and so on). Keep each value inside the double quotes, and do not put a double quote or a backslash in a value. To change the Razorpay keys, the site name, the email, or the business details, run `sudo bash /opt/bayfind/deploy/setup.sh` instead: it checks what you type.

To make a **new dashboard password**: `sudo bash /opt/bayfind/deploy/setup.sh --new-password`.

### Backups

- Every night at about 03:17 server time (usually UTC, which is 08:47 in India) the server copies your bookings to `/var/backups/bayfind`, and keeps the last 30 days. If the bookings file is ever damaged, the copy is whole.
- **Those copies are on the same server.** If the server itself is lost, they are lost too. Download them to your own computer now and then (the date is in each file name):

  ```
  scp "root@SERVER_IP:/var/backups/bayfind/bookings-*.json" .
  ```

- Most server companies also sell automatic **snapshots** or **backups** of the whole server for a small monthly fee. They are worth it for a business.

To make a copy right now: `sudo bash /opt/bayfind/deploy/backup.sh`.

**To restore** a copy on this server, or on a new one made with steps 4 to 7:

```
sudo systemctl stop bayfind
sudo install -o bayfind -g bayfind -m 600 /root/bookings-2026-11-01_031700.json /var/lib/bayfind/bookings.json
sudo systemctl start bayfind
```

(with the name of your copy in the second line).

### Keep the server itself up to date

The script turns on **automatic security updates**. Once a month, log in and run:

```
sudo apt-get update
sudo apt-get -y upgrade
```

If it says that a restart is needed (or `ls /var/run/reboot-required` shows a file), run `sudo reboot` at a quiet hour. Bookings are saved, and the site and the web server start by themselves within a minute.

Turn on two-step login at your server company, at Razorpay, and at your domain seller (and at Anthropic, if you use the AI chat answers).

### If something breaks

First run `sudo bash /opt/bayfind/deploy/check.sh`. Then look in this table.

| What you see | What to do |
|---|---|
| `ssh` says `Connection timed out` | The IP address is wrong, the server is not ready yet, or the company's firewall blocks port 22. |
| `ssh` says `Permission denied` | Wrong login name (`root` or `ubuntu`), or the wrong key or password. |
| The script says "This script is for Ubuntu 22.04 or newer and Debian 12 or newer" | The server has another operating system. Create a new server with **Ubuntu 24.04** (step 4). |
| The script says "HTTPS is not working yet" | The domain does not point at the server (step 5), or ports 80 and 443 are closed at the server company (step 4). Fix it, wait ten minutes, run the script again. |
| The browser says "Your connection is not private" or "This site can't be reached" right after the setup | The same two causes. Caddy keeps trying by itself. `sudo journalctl -u caddy -n 40` shows what it says. |
| The pages show a yellow "Demo mode" or booking is switched off | The Razorpay keys are missing. Run `sudo bash /opt/bayfind/deploy/setup.sh` and paste them. |
| The Razorpay window says authentication failed | A test key is mixed with a live key, or the Key Id and Key Secret do not belong together. Run the setup again and paste both again. |
| The dashboard asks for the password again and again | Wrong password. `sudo grep OPERATOR_PASSWORD /etc/bayfind/bayfind.env` shows it. After 10 wrong tries in a minute it waits a minute. |
| The dashboard says "Refund needed" | The message says why. Fix that, then press **Retry refund**. If the message says that the server restarted while the refund was being sent, just press **Retry refund**. That is safe: Razorpay does not refund the same payment in full twice, so if the first try did go through, the booking is marked as refunded and nothing more is sent. |
| A driver paid but has no booking | Wait a few minutes (the site re-checks by itself a minute after the hold ends). If there is still none, refund the payment in the Razorpay Dashboard. |
| The chat window is gone, or has no **Ask us** button | `CHAT_ENABLED="off"` is in the settings file. Remove that line and run `sudo systemctl restart bayfind`. The dashboard never has the button. |
| You added `ANTHROPIC_API_KEY` but the chat still says “Instant answers”, or the dashboard's **Setup check** says “The AI is not answering” | Open `/dashboard`, **Setup check**, **Run the check**: its **Chat assistant** part says why. The usual causes: the key was copied in part, or has a space inside it (401); there is no credit or a payment problem on Anthropic's Billing page (402); `CHAT_MODEL` names a model that does not exist (404); a spend or rate limit on the Anthropic account was reached (429); or you did not run `sudo systemctl restart bayfind` after adding the line. Nothing is lost meanwhile: drivers get the built-in answers. |
| The site is down | `sudo systemctl status bayfind` and `sudo journalctl -u bayfind -n 50` say why. `sudo systemctl restart bayfind` often fixes it. |
| The disk is full | `check.sh` says so. Old nightly copies are removed after 30 days. Ask your server company about a bigger disk. |

The log of the setup script itself is in `/var/log/bayfind-setup.log`. It never contains your passwords or keys.

## Optional extra: let an AI answer in the chat

Every public page has a yellow **Ask us** button that opens a chat window. **It already works, with no setup and no cost**: it answers from your own prices, hold time and contact details and from the live count of free bays. This extra lets Anthropic's Claude AI write the answers instead, so drivers can ask in their own words and language. It cannot book, cancel or refund anything and it never sees a booking. If the AI is ever unavailable, drivers get the built-in answers and nothing breaks. `README.md`, section 3, “The chat assistant”, says more.

**It costs a little, on a separate bill.** Anthropic charges your own Anthropic account for each answer, in US dollars. At the price Anthropic lists for the model the site uses (`claude-haiku-5-5`: $0.10 per million input tokens and $0.50 per million output tokens, see its [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)), an ordinary answer is a small fraction of one US cent. That is an estimate, so look at the pricing page and at the usage on your own Anthropic account. The site gives at most 500 AI answers a day (the setting `CHAT_DAILY_LIMIT`), which at the very most is a few US dollars a day, and step 3 below puts a spending cap of your own on Anthropic's side as well.

**With the AI on, what a driver types in the chat is sent to Anthropic.** The site's `/privacy` page says so by itself as soon as the key is in. The site does not keep the chat and does not write it to its log.

1. **Make an Anthropic account** at <https://platform.claude.com> (the Anthropic Console). It is separate from a Claude chat subscription. Confirm your email if it asks.
2. **Add credit.** Open **Billing** (<https://platform.claude.com/settings/billing>) and add a card or credit. For a card from an Indian bank, switch on international online payments in your bank's app first.
3. **Set a spending cap (recommended).** Open **Workspaces** (<https://platform.claude.com/settings/workspaces>), create a workspace called `parking-site`, open it, and set a monthly **spend limit** you are comfortable with (and an alert, if it offers one). The Default Workspace cannot have a limit, which is why a workspace of its own is worth a minute.
4. **Create the key.** Open **API keys** (<https://platform.claude.com/settings/keys>) and press **Create key**. Name it `parking-site` and choose that workspace. **Copy the key at once**: it starts with `sk-ant-` and is shown only one time. Keep it as private as the Razorpay Key Secret.
5. **Put the key on the server.** Log in to the server (step 4) and open the settings file:

   ```
   sudo nano /etc/bayfind/bayfind.env
   ```

   Go to the end of the file and add one line, with your key between the double quotes, no spaces, and nothing else on the line:

   ```
   ANTHROPIC_API_KEY="sk-ant-xxxxxxxxxxxxxxxx"
   ```

   Save with **Ctrl+O**, then Enter, and leave with **Ctrl+X**. Then restart the site so that it reads the line:

   ```
   sudo systemctl restart bayfind
   ```

   An update with `setup.sh` keeps this line, because the script leaves every line you added yourself as it was.
6. **Check that it works.**
   - Run `sudo journalctl -u bayfind -n 30`. You should see a line like `Chat        AI assistant (claude-haiku-5-5): up to 500 AI answers a day, instant answers after that.` A line that says `Instant answers, no AI` means the key did not arrive: look at the line in the settings file. A `Note` line that says the key does not look like an Anthropic key means it was copied in part.
   - Open your site, press **Ask us** and ask something, for example “What does parking cost on a Sunday?” The header of the chat window says **AI assistant** when the site has a key and **Instant answers** when it has not. (It tells what the site is set up to do; the next check tells whether the AI really answered.)
   - Open `/dashboard`, scroll to **Setup check** and press **Run the check**. The **Chat assistant** part says how drivers are being answered, how many questions were sent to the AI today and, if the AI is not answering, why: a key that Anthropic refused, no credit left, a model name that does not exist, or a limit that was reached.

**Other settings** (all optional, added as lines in the same file in the same way, each followed by `sudo systemctl restart bayfind`):

| Line | What it does |
|---|---|
| `CHAT_DAILY_LIMIT="500"` | The most AI answers the whole site gives in a day (500 if you add no line). Past it, drivers get the built-in answers until the next day. `0` stops the AI and keeps the key. |
| `CHAT_MODEL="claude-haiku-5-5"` | Another AI model. Leave the line out for the default, the small, fast and cheap one. A wrong name makes the AI fail (the Setup check says so), and a bigger model costs much more per answer. |
| `CHAT_ENABLED="off"` | Hides the chat window on every page. |

**To stop the AI answers**, delete the `ANTHROPIC_API_KEY` line (or put `CHAT_DAILY_LIMIT="0"`) and restart the site. To stop the billing for good, also delete the key on Anthropic's keys page.

---

## What the script did to your server

For the curious, or for the person who looks after it:

| Where | What |
|---|---|
| `/opt/bayfind` | The site's program files. Replaced by every update. Owned by root, so the site cannot change its own code. |
| `/opt/bayfind.prev` | The previous version, kept for roll-back. |
| `/etc/bayfind/bayfind.env` | Your settings and secrets (including `ANTHROPIC_API_KEY`, if you added one). Only the administrator can read it. |
| `/var/lib/bayfind/bookings.json` | Your bookings. |
| `/var/backups/bayfind` | The nightly copies. |
| `/etc/caddy/Caddyfile` | Caddy's settings. The script writes this file. If you had your own, it was saved as `Caddyfile.before-bayfind`. Do not change it by hand: the next run of the script writes it again. |
| `bayfind.service` | The site as a service. It runs as its own user (`bayfind`), which can do nothing except run the site and write the bookings. It restarts after a crash. |
| `bayfind-backup.timer` | The nightly backup. |
| Firewall (`ufw`) | Only SSH, 80 and 443 are open. |
| Automatic updates | Security updates for the server install themselves. |

## Words used in this guide

- **Server / VPS:** a computer you rent in a data centre. It is always on.
- **Domain name:** the address people type, like `parking.yourname.in`.
- **DNS / A record:** the phone book of the internet. An A record says "this name lives at this number".
- **IP address:** the number of a computer on the internet, like `143.110.200.15`.
- **SSH:** a safe way to type commands on the server from your own computer.
- **HTTPS / padlock:** the safe, encrypted way a browser talks to a website.
- **Caddy:** the program that shows your site to visitors and handles the padlock.
- **Webhook:** a message Razorpay sends your site when something happens, for example a payment.
- **API key (Anthropic):** a long secret text that lets your site ask Anthropic's AI for an answer, and makes Anthropic bill your account for it.
- **Test mode / live mode:** Razorpay keeps two separate worlds. In test mode nothing real is charged. In live mode real money moves.

If you get stuck, run `sudo bash /opt/bayfind/deploy/check.sh`, and send its output to the person who helps you. It contains no passwords.
