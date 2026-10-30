#!/usr/bin/env bash
#
# One-step server setup for the Bayfind parking site.
# For Ubuntu 22.04 or newer, or Debian 12 or newer, on a normal server (not a container).
#
#   sudo bash deploy/setup.sh                  first install. Also how you change a setting or update the site.
#   sudo bash deploy/setup.sh --yes            the same, but ask nothing: keep every setting you have now
#   sudo bash deploy/setup.sh --new-password   make a new password for the operator dashboard
#   sudo bash deploy/setup.sh --no-firewall    leave the server's firewall alone
#   sudo bash deploy/setup.sh --help
#
# What it does:
#   1. installs Node.js and the Caddy web server (Caddy gets and renews the HTTPS certificate by itself)
#   2. puts the site in /opt/bayfind and keeps your settings in /etc/bayfind/bayfind.env
#   3. runs the site as a service that comes back after a crash or a reboot
#   4. opens only the doors the site needs (SSH, 80 and 443)
#   5. schedules a nightly copy of the bookings file
#
# Running it again is safe. It keeps your bookings and your settings, and if a new version of the site does not
# start, it puts the previous version back.

set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

NODE_MAJOR="${BAYFIND_NODE_MAJOR:-24}"      # used only when Node.js has to be installed
LOG="${BAYFIND_LOG:-/var/log/bayfind-setup.log}"
HTTPS_WAIT="${BAYFIND_HTTPS_WAIT:-90}"      # seconds to wait for the HTTPS certificate
START_WAIT="${BAYFIND_START_WAIT:-30}"      # seconds to wait for the site to start
NEW_PASSWORD=0
SKIP_FIREWALL=0

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/setup.sh [options]

  (no option)       ask a few questions, then install or update the site
  -y, --yes         ask nothing; keep every setting you have now (handy for updates)
  --new-password    make a new password for the operator dashboard
  --no-firewall     leave the server's firewall alone
  -h, --help        show this text
EOF
}

for arg in "$@"; do
  case $arg in
    -y | --yes) ASSUME_YES=1 ;;
    --new-password) NEW_PASSWORD=1 ;;
    --no-firewall) SKIP_FIREWALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "I do not know the option \"$arg\". Run it with --help to see the options." ;;
  esac
done

trap 'printf "\n%sThe setup stopped unexpectedly (script line %s).%s\nNothing is lost. Read the message above, fix what it says, and run the same command again.\n" "$RED" "$LINENO" "$RESET" >&2' ERR

# run "what this does" command [arguments]  ->  shows the step, keeps the noise in the log, stops if it fails
run() {
  local what=$1
  shift
  printf '  ...      %s\n' "$what"
  if ! "$@" >>"$LOG" 2>&1; then
    bad "That step failed: $what"
    say "           The last lines of the log ($LOG):"
    tail -n 15 "$LOG" | sed 's/^/           /' >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------------------------------------------
step "1. Looking at this server"

[ "$(id -u)" -eq 0 ] || die "Run this with sudo:   sudo bash deploy/setup.sh"
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
chmod 600 "$LOG"
printf '\n==== %s  setup.sh %s\n' "$(date '+%F %T')" "$*" >>"$LOG"

os=$( [ -r /etc/os-release ] && . /etc/os-release && printf '%s:%s:%s' "${ID:-}" "${VERSION_ID:-}" "${PRETTY_NAME:-}" ) || os=''
case $os in
  ubuntu:2[2-9].04:* | debian:1[2-9]:*) ok "${os##*:}" ;;
  *) die "This script is for Ubuntu 22.04 or newer and Debian 12 or newer. This server is: ${os##*:}. Create a new server with Ubuntu 24.04 and try again." ;;
esac
if [ ! -d /run/systemd/system ] && [ -z "${BAYFIND_TESTING-}" ]; then
  die "This server does not run systemd, which the setup needs. Use a normal Ubuntu or Debian server, not a container."
fi

SRC=$(cd "$HERE/.." && pwd)
for f in server.js package.json package-lock.json src/app.js public/index.html deploy/bayfind.service deploy/bayfind-backup.service deploy/bayfind-backup.timer deploy/Caddyfile.template deploy/backup.sh; do
  [ -e "$SRC/$f" ] || die "The file $f is missing from $SRC. Unzip the whole bayfind-smart-parking.zip and run the script from inside that folder."
done
ok "Found the site's files in $SRC"

if [ -f "$ENV_FILE" ]; then
  ok "This server already has settings ($ENV_FILE), so this run updates it"
else
  ok "A fresh server: this run installs everything"
fi

# ---------------------------------------------------------------------------------------------------------------
step "2. Your settings"
if [ "$ASSUME_YES" = 1 ]; then say "  Keeping the settings you have now (--yes)."; else say "  A few questions. Press Enter to accept what is offered."; fi

current_domain=$(env_get SITE_DOMAIN)
domain_hint=''
[ -n "$current_domain" ] || domain_hint='Type just the name: no https://, no spaces.'
while :; do
  ask DOMAIN "Your website address: the domain name you bought, for example parking.example.com" "$current_domain" '' "$domain_hint"
  DOMAIN=$(clean_domain "$DOMAIN")
  if valid_domain "$DOMAIN"; then break; fi
  if [ -z "$DOMAIN" ]; then bad "Please type your website address, for example parking.example.com"; else bad "\"$DOMAIN\" does not look like a domain name. Type just the name, like parking.example.com (no https://, no spaces)."; fi
  if [ "$ASSUME_YES" = 1 ] || [ -n "${BAYFIND_DOMAIN-}" ] || [ "$ASK_EOF" = 1 ]; then die "A website address is needed."; fi
done

current_name=$(env_get SITE_NAME)
ask_valid SITE_NAME "The name of your parking business. It is shown at the top of every page (up to 40 characters)." "${current_name:-Bayfind}" valid_site_name "The name must be 1 to 40 characters, without quotes or backslashes."

ask_valid SUPPORT_EMAIL "An email address that customers can write to. It is shown in the footer of every page, and Razorpay wants a contact address on a live site." "$(env_get SUPPORT_EMAIL)" valid_email "That does not look like an email address."

ask_valid KEY_ID "Razorpay Key Id. It starts with rzp_test_ while you are testing, and rzp_live_ for real money.
  You can leave it empty now and add it later: booking stays switched off until both Razorpay keys are set." "$(env_get RAZORPAY_KEY_ID)" valid_key_id "That does not look like a Razorpay Key Id (it looks like rzp_test_AbC123xyz). Copy the Key Id, not the Key Secret."
if [ -n "$KEY_ID" ]; then
  ask_valid KEY_SECRET "Razorpay Key Secret (hidden while you type or paste)." "$(env_get RAZORPAY_KEY_SECRET)" valid_secret "That does not look right: it needs 8 or more characters, with no spaces or quotes. Copy the Key Secret again." secret
else
  KEY_SECRET=''
fi

# The Contact, Terms and Privacy pages show these. Razorpay wants them on a site that takes real money, so they are
# asked only when the keys are live. Test mode keeps whatever is saved (empty at first).
BUSINESS_NAME=$(env_get BUSINESS_NAME)
SUPPORT_PHONE=$(env_get SUPPORT_PHONE)
BUSINESS_ADDRESS=$(env_get BUSINESS_ADDRESS)
if [[ $KEY_ID == rzp_live_* ]]; then
  ask_valid BUSINESS_NAME "The name of your business, as it should appear on the Contact, Terms and Privacy pages (use the name on your Razorpay account). Up to 80 characters." "$BUSINESS_NAME" valid_business_name "The name must be at most 80 characters, without quotes or backslashes."
  ask_valid SUPPORT_PHONE "A phone number that customers can call. Razorpay wants one on the Contact page." "$SUPPORT_PHONE" valid_phone "That does not look like a phone number. Use digits, spaces, + ( ) and - only, for example +91 98765 43210."
  ask_valid BUSINESS_ADDRESS "The address of your business, on one line, for the Contact page." "$BUSINESS_ADDRESS" valid_address "The address must be at most 240 characters, on one line, without quotes or backslashes."
fi

# The operator password is made once. Later runs keep it, unless --new-password is given.
PASSWORD_NOTE=kept
OPERATOR_PASSWORD=$(env_get OPERATOR_PASSWORD)
if [ -n "${BAYFIND_OPERATOR_PASSWORD-}" ]; then
  OPERATOR_PASSWORD=$BAYFIND_OPERATOR_PASSWORD
  valid_password "$OPERATOR_PASSWORD" || die "The operator password needs 12 or more characters, with no spaces or quotes."
  PASSWORD_NOTE=chosen
elif [ -z "$OPERATOR_PASSWORD" ] || [ "$NEW_PASSWORD" = 1 ]; then
  if [ "$ASSUME_YES" = 1 ]; then
    OPERATOR_PASSWORD=$(random_string 24)
    PASSWORD_NOTE=made
  else
    while :; do
      ask OPERATOR_PASSWORD "A password for the operator dashboard, where you see payments and cancel bookings (12 or more characters, no spaces)." "" secret "Press Enter and I will make up a strong one for you."
      if [ -z "$OPERATOR_PASSWORD" ]; then OPERATOR_PASSWORD=$(random_string 24); PASSWORD_NOTE=made; break; fi
      if valid_password "$OPERATOR_PASSWORD"; then PASSWORD_NOTE=chosen; break; fi
      bad "It needs 12 or more characters, with no spaces, quotes or backslashes."
      if [ "$ASK_EOF" = 1 ]; then die "No usable password was given."; fi
    done
  fi
fi

WEBHOOK_NOTE=kept
WEBHOOK_SECRET=$(env_get RAZORPAY_WEBHOOK_SECRET)
if [ -n "${BAYFIND_RAZORPAY_WEBHOOK_SECRET-}" ]; then
  WEBHOOK_SECRET=$BAYFIND_RAZORPAY_WEBHOOK_SECRET
  valid_secret "$WEBHOOK_SECRET" || die "The webhook secret needs 8 or more characters, with no spaces or quotes."
  WEBHOOK_NOTE=chosen
elif [ -z "$WEBHOOK_SECRET" ]; then
  WEBHOOK_SECRET=$(random_string 32)
  WEBHOOK_NOTE=made
fi

PORT=$(env_get PORT)
PORT=${PORT:-3000}

if [ -z "$KEY_ID" ] || [ -z "$KEY_SECRET" ]; then
  PAYMENTS_TEXT="OFF: no Razorpay keys yet, so booking stays switched off until you add them"
elif [[ $KEY_ID == rzp_live_* ]]; then
  PAYMENTS_TEXT="LIVE: real payments, real money"
else
  PAYMENTS_TEXT="TEST mode: nothing real is charged"
fi

printf '\n  %sThis is what I will set up%s\n' "$BOLD" "$RESET"
printf '    Website address   https://%s\n' "$DOMAIN"
printf '    Name on the pages %s\n' "$SITE_NAME"
printf '    Support email     %s\n' "${SUPPORT_EMAIL:-(none)}"
printf '    Payments          %s\n' "$PAYMENTS_TEXT"
if [[ $KEY_ID == rzp_live_* ]]; then
  printf '    Business name     %s\n' "${BUSINESS_NAME:-(not set: the site name is used)}"
  printf '    Phone             %s\n' "${SUPPORT_PHONE:-(none)}"
  printf '    Address           %s\n' "${BUSINESS_ADDRESS:-(none)}"
fi
case $PASSWORD_NOTE in
  made) printf '    Dashboard         a new password, shown at the end\n' ;;
  chosen) printf '    Dashboard         the password you typed\n' ;;
  *) printf '    Dashboard         the password you already have\n' ;;
esac
if ! yes_no "Go ahead?" y; then
  if [ "$ASK_EOF" = 1 ]; then die "Nothing was changed. There was nobody to answer the questions (is this a terminal?). To keep the settings you have now, add --yes."; fi
  die "Nothing was changed."
fi

# ---------------------------------------------------------------------------------------------------------------
step "3. Checking the domain name"

SERVER_IP=$(public_ip)
DOMAIN_IP=$(resolve_ipv4 "$DOMAIN")
DNS_OK=1
if [ -z "$SERVER_IP" ]; then
  warn "I could not find out this server's public address, so I cannot check where $DOMAIN points."
elif [ -z "$DOMAIN_IP" ]; then
  warn "$DOMAIN does not point anywhere yet. In your domain's DNS settings add an A record for it with the value $SERVER_IP."
  DNS_OK=0
elif [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  warn "$DOMAIN points to $DOMAIN_IP, but this server is $SERVER_IP. Change the A record to $SERVER_IP. (If you use Cloudflare, switch the orange cloud to grey, \"DNS only\".)"
  DNS_OK=0
else
  ok "$DOMAIN points to this server ($SERVER_IP)"
fi
if [ "$DNS_OK" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  if ! yes_no "Carry on anyway? The site will be installed, but HTTPS cannot work until the domain points here." n; then
    die "Stopped. Point the domain at this server, wait a few minutes, then run the same command again."
  fi
fi

WWW=0
case $DOMAIN in
  www.*) ;;
  *)
    if [ -n "$SERVER_IP" ] && [ "$(resolve_ipv4 "www.$DOMAIN")" = "$SERVER_IP" ]; then
      WWW=1
      ok "www.$DOMAIN points here too, so it will send visitors to $DOMAIN"
    fi
    ;;
esac

# ---------------------------------------------------------------------------------------------------------------
step "4. Installing the software (a minute or two)"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT=(apt-get -o DPkg::Lock::Timeout=300 -y -qq)
run "Refreshing the list of available software" "${APT[@]}" update
run "Installing basic tools (curl, gnupg, firewall)" "${APT[@]}" install ca-certificates curl gnupg ufw unattended-upgrades

node_path=$(command -v node || true)
node_ok=0
if [ -n "$node_path" ]; then
  case $node_path in
    /root/* | /home/*) ;;   # a copy inside someone's home folder cannot be used by the service
    *) [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && node_ok=1 ;;
  esac
fi
if [ "$node_ok" = 0 ]; then
  nodesource_script=$(mktemp)
  run "Downloading the Node.js $NODE_MAJOR installer from NodeSource" curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$nodesource_script"
  run "Adding the Node.js $NODE_MAJOR software source" bash "$nodesource_script"
  rm -f "$nodesource_script"
  run "Installing Node.js $NODE_MAJOR" "${APT[@]}" install nodejs
  hash -r
fi
NODE_BIN=$(command -v node)
case $NODE_BIN in /root/* | /home/*) [ -x /usr/bin/node ] && NODE_BIN=/usr/bin/node ;; esac
ok "Node.js $("$NODE_BIN" --version) is installed ($NODE_BIN)"

if ! command -v caddy >/dev/null 2>&1; then
  run "Adding the Caddy software source" bash -c 'set -eo pipefail
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list'
  run "Refreshing the list of available software" "${APT[@]}" update
  run "Installing Caddy" "${APT[@]}" install caddy
fi
ok "Caddy $(caddy version | awk '{ print $1 }') is installed"

# ---------------------------------------------------------------------------------------------------------------
step "5. Putting the site in place"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "Made the \"$SERVICE_USER\" user, which can do nothing except run the site"
fi
install -d -m 755 "$CONF_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 700 "$BACKUP_DIR"

# The new version is prepared next to the old one. Only when it is ready does it take the old one's place.
NEW="$APP_DIR.new"
PREV="$APP_DIR.prev"
rm -rf "$NEW"
mkdir -p "$NEW"
for item in server.js package.json package-lock.json README.md DEPLOY.md .env.example src public deploy; do
  if [ -e "$SRC/$item" ]; then cp -a "$SRC/$item" "$NEW/"; fi
done
npm_install() { (cd "$NEW" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error); }
run "Installing the site's libraries (npm ci)" npm_install
run "Checking that the new files load" "$NODE_BIN" -e "require('$NEW/src/config'); require('$NEW/src/app')"
chown -R root:root "$NEW"
chmod -R go-w,a+rX "$NEW"

# Settings. Lines you added yourself (prices, for example) are kept as they are.
env_set NODE_ENV production
env_set HOST 127.0.0.1
env_set PORT "$PORT"
[ -n "$(env_get TRUST_PROXY)" ] || env_set TRUST_PROXY 1
env_set DATA_DIR "$STATE_DIR"
[ -n "$(env_get OPERATOR_USER)" ] || env_set OPERATOR_USER operator
env_set OPERATOR_PASSWORD "$OPERATOR_PASSWORD"
env_set SITE_DOMAIN "$DOMAIN"
env_set SITE_NAME "$SITE_NAME"
env_set SUPPORT_EMAIL "$SUPPORT_EMAIL"
env_set BUSINESS_NAME "$BUSINESS_NAME"
env_set SUPPORT_PHONE "$SUPPORT_PHONE"
env_set BUSINESS_ADDRESS "$BUSINESS_ADDRESS"
env_set RAZORPAY_KEY_ID "$KEY_ID"
env_set RAZORPAY_KEY_SECRET "$KEY_SECRET"
env_set RAZORPAY_WEBHOOK_SECRET "$WEBHOOK_SECRET"
ok "Saved your settings in $ENV_FILE (only root can read that file)"

if [ -d "$APP_DIR" ]; then
  rm -rf "$PREV"
  mv "$APP_DIR" "$PREV"
fi
mv "$NEW" "$APP_DIR"
ok "The site's files are in $APP_DIR"

# ---------------------------------------------------------------------------------------------------------------
step "6. Starting the site"

# render TEMPLATE DESTINATION  ->  fills in the __CAPITAL__ words
render() {
  sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__ENV_FILE__#$ENV_FILE#g" -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" "$1" >"$2"
  chmod 644 "$2"
}
render "$APP_DIR/deploy/bayfind.service" "$SYSTEMD_DIR/bayfind.service"
render "$APP_DIR/deploy/bayfind-backup.service" "$SYSTEMD_DIR/bayfind-backup.service"
render "$APP_DIR/deploy/bayfind-backup.timer" "$SYSTEMD_DIR/bayfind-backup.timer"
if command -v systemd-analyze >/dev/null 2>&1 && ! systemd-analyze verify "$SYSTEMD_DIR/bayfind.service" >>"$LOG" 2>&1; then
  warn "systemd has a remark about the service file (it is in $LOG). The site may still work."
fi
run "Loading the service files" systemctl daemon-reload
run "Making the site and the nightly backup start by themselves after a reboot" systemctl enable bayfind.service bayfind-backup.timer
run "Starting the site" systemctl restart bayfind.service
run "Starting the nightly backup timer" systemctl start bayfind-backup.timer

if wait_for "http://127.0.0.1:$PORT/healthz" "$START_WAIT"; then
  ok "The site is running"
else
  bad "The site did not start. Its log says:"
  journalctl -u bayfind -n 20 --no-pager 2>/dev/null | sed 's/^/           /' >&2 || true
  if [ -d "$PREV" ]; then
    warn "Putting the previous version back."
    rm -rf "$APP_DIR.failed"
    mv "$APP_DIR" "$APP_DIR.failed"
    mv "$PREV" "$APP_DIR"
    systemctl restart bayfind.service || true
    if wait_for "http://127.0.0.1:$PORT/healthz" "$START_WAIT"; then
      die "The new version did not start, so the previous version is running again. The new files are kept in $APP_DIR.failed. Your bookings are untouched."
    fi
  fi
  die "The site did not start. Run   sudo journalctl -u bayfind -n 50   to see why."
fi

PAYMENTS_MODE=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/config" 2>/dev/null | json_get payments.mode || true)
PAYMENTS_TEST=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/config" 2>/dev/null | json_get payments.test || true)
case $PAYMENTS_MODE:$PAYMENTS_TEST in
  razorpay:true) ok "Payments: Razorpay TEST mode (nothing real is charged)" ;;
  razorpay:false) ok "Payments: Razorpay LIVE mode (real money)" ;;
  unavailable:*) warn "Payments: switched off, because there are no Razorpay keys yet. Add them by running this script again." ;;
  *) warn "Payments: the site reports \"$PAYMENTS_MODE\", which is not what I expected for a live server." ;;
esac

# ---------------------------------------------------------------------------------------------------------------
step "7. Turning on HTTPS"

caddy_new=$(mktemp)
render "$APP_DIR/deploy/Caddyfile.template" "$caddy_new"
if [ "$WWW" = 1 ]; then
  printf '\nwww.%s {\n\tredir https://%s{uri} permanent\n}\n' "$DOMAIN" "$DOMAIN" >>"$caddy_new"
fi
install -d -m 755 "$(dirname "$CADDYFILE")"
if [ -f "$CADDYFILE" ]; then
  [ -f "$CADDYFILE.before-bayfind" ] || cp -a "$CADDYFILE" "$CADDYFILE.before-bayfind"
  cp -a "$CADDYFILE" "$CADDYFILE.previous"
fi
install -m 644 "$caddy_new" "$CADDYFILE"
rm -f "$caddy_new"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >>"$LOG" 2>&1; then
  bad "Caddy did not accept its settings file ($CADDYFILE):"
  caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -n 8 | sed 's/^/           /' >&2 || true
  if [ -f "$CADDYFILE.previous" ]; then install -m 644 "$CADDYFILE.previous" "$CADDYFILE"; fi
  die "HTTPS was not turned on. The site itself is running on this server's port $PORT."
fi
systemctl enable caddy >>"$LOG" 2>&1 || true
run "Telling Caddy about $DOMAIN" systemctl reload-or-restart caddy

# ---------------------------------------------------------------------------------------------------------------
step "8. The firewall"

# The ports sshd listens on, plus the one this very session uses, so that turning the firewall on never locks you out.
ssh_ports() {
  if [ -n "${SSH_CONNECTION-}" ]; then printf '%s\n' "${SSH_CONNECTION##* }"; fi
  if command -v sshd >/dev/null 2>&1; then sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true; fi
}
if [ "$SKIP_FIREWALL" = 1 ]; then
  warn "The firewall was left alone (--no-firewall)."
else
  ports=$(ssh_ports | grep -E '^[0-9]{1,5}$' | sort -un | tr '\n' ' ' || true)
  [ -n "${ports// /}" ] || ports='22 '
  fw() { ufw "$@" >>"$LOG" 2>&1; }
  fw_ok=1
  for p in $ports; do fw allow "$p/tcp" || fw_ok=0; done
  fw allow 80/tcp || fw_ok=0
  fw allow 443/tcp || fw_ok=0
  fw allow 443/udp || fw_ok=0
  if [ "$fw_ok" = 1 ] && fw --force enable; then
    ok "Firewall on: only SSH (port ${ports% }), 80 and 443 are open"
  else
    warn "I could not turn the firewall on (see $LOG). The site works without it. Check your hosting company's own firewall settings too."
  fi
fi

# ---------------------------------------------------------------------------------------------------------------
step "9. Waiting for the HTTPS certificate (up to $HTTPS_WAIT seconds)"

HTTPS_OK=0
if wait_for "https://$DOMAIN/healthz" "$HTTPS_WAIT" --resolve "$DOMAIN:443:127.0.0.1"; then
  HTTPS_OK=1
  ok "https://$DOMAIN works, with a valid certificate"
else
  warn "https://$DOMAIN is not answering yet. The usual reasons:"
  say "           - the domain does not point at this server yet (give DNS up to an hour, then run this script again)"
  say "           - ports 80 and 443 are closed in your hosting company's own firewall (look for \"Firewall\" or \"Security group\")"
  say "           Caddy's latest messages:"
  journalctl -u caddy -n 6 --no-pager 2>/dev/null | cut -c1-200 | sed 's/^/           /' || true
fi

# ---------------------------------------------------------------------------------------------------------------
printf '\n%s%s%s\n' "$BOLD" "All done." "$RESET"
printf '\n  Your site        https://%s\n' "$DOMAIN"
printf '  Dashboard        https://%s/dashboard\n' "$DOMAIN"
printf '                     user name   %s\n' "$(env_get OPERATOR_USER)"
if [ "$PASSWORD_NOTE" = kept ]; then
  printf '                     password    (unchanged. To see it:  sudo grep OPERATOR_PASSWORD %s)\n' "$ENV_FILE"
else
  printf '                     password    %s\n' "$OPERATOR_PASSWORD"
  printf '                     Write this password down now. It is not shown again.\n'
fi
printf '  Payments         %s\n' "$PAYMENTS_TEXT"
printf '\n  Razorpay webhook (add it once; DEPLOY.md, step 8)\n'
printf '    URL     https://%s/api/razorpay/webhook\n' "$DOMAIN"
if [ "$WEBHOOK_NOTE" = kept ]; then
  printf '    Secret  (unchanged. To see it:  sudo grep RAZORPAY_WEBHOOK_SECRET %s)\n' "$ENV_FILE"
else
  printf '    Secret  %s\n' "$WEBHOOK_SECRET"
fi
printf '    Events  payment.captured and order.paid\n'
printf '\n  Policy pages (Razorpay asks for these addresses when you apply for live payments)\n'
for page in pricing terms privacy refunds shipping contact; do printf '    https://%s/%s\n' "$DOMAIN" "$page"; done
if [[ $KEY_ID == rzp_live_* ]]; then
  printf '    Read them once and make sure they match how you really run the lot (DEPLOY.md, step 10).\n'
fi
printf '\n  Handy commands\n'
printf '    sudo bash %s/deploy/check.sh        is everything healthy?\n' "$APP_DIR"
printf '    sudo journalctl -u bayfind -f        watch the site'"'"'s log (Ctrl+C to stop watching)\n'
printf '    sudo bash %s/deploy/setup.sh        change a setting, or install a new version\n' "$APP_DIR"
if [ "$HTTPS_OK" = 0 ]; then
  printf '\n  %sHTTPS is not working yet.%s Fix the domain or firewall as described above, then run the setup again.\n' "$YELLOW" "$RESET"
fi
printf '\n'
