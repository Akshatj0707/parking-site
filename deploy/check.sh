#!/usr/bin/env bash
#
# Looks at the live site and says what works and what does not. It changes nothing, so it is safe to run any time.
#
#   sudo bash /opt/bayfind/deploy/check.sh           the checklist
#   sudo bash /opt/bayfind/deploy/check.sh --logs    the checklist, then the last lines of the site's log
#
# Every line starts with OK, CHECK (worth a look) or PROBLEM (the site is not fully working). Nothing secret is
# printed, so you can paste the whole output when you ask someone for help.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SHOW_LOGS=0
for arg in "$@"; do
  case $arg in
    --logs) SHOW_LOGS=1 ;;
    -h | --help) sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "I do not know the option \"$arg\". Use --logs, or no option." ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run this with sudo:   sudo bash $0"
[ -f "$ENV_FILE" ] || die "I cannot find $ENV_FILE. Has deploy/setup.sh been run on this server?"

PROBLEMS=0
problem() {
  bad "$@"
  PROBLEMS=$((PROBLEMS + 1))
}

DOMAIN=$(env_get SITE_DOMAIN)
PORT=$(env_get PORT)
PORT=${PORT:-3000}

# ---------------------------------------------------------------------------------------------------------------
step "The programs"

if systemctl is-active --quiet bayfind.service; then
  ok "The site (bayfind) is running"
else
  problem "The site (bayfind) is not running. To see why:   sudo journalctl -u bayfind -n 50"
fi
if systemctl is-active --quiet caddy.service; then
  ok "The web server (caddy) is running"
else
  problem "The web server (caddy) is not running. To see why:   sudo journalctl -u caddy -n 50"
fi
if systemctl is-enabled --quiet bayfind.service && systemctl is-enabled --quiet caddy.service; then
  ok "Both start by themselves after a reboot"
else
  warn "One of them is not set to start after a reboot. Run   sudo bash $APP_DIR/deploy/setup.sh --yes   to fix that."
fi

# ---------------------------------------------------------------------------------------------------------------
step "The site"

config=$(curl -fsS --max-time 4 "http://127.0.0.1:$PORT/api/config" 2>/dev/null || true)
if [ -z "$config" ]; then
  problem "The site does not answer on port $PORT of this server."
else
  ok "The site answers on this server"
  mode=$(printf '%s' "$config" | json_get payments.mode)
  test_keys=$(printf '%s' "$config" | json_get payments.test)
  case $mode:$test_keys in
    razorpay:true) ok "Payments: Razorpay TEST mode (nothing real is charged)" ;;
    razorpay:false) ok "Payments: Razorpay LIVE mode (real money)" ;;
    unavailable:*) warn "Payments are off because there are no Razorpay keys. Run   sudo bash $APP_DIR/deploy/setup.sh   to add them." ;;
    demo:*) problem "The site is in demo mode, which should never happen on a live server (NODE_ENV should be production)." ;;
    *) warn "The site reports payment mode \"$mode\", which I did not expect." ;;
  esac
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT/dashboard" 2>/dev/null || true)
  case $code in
    401) ok "The dashboard asks for a password" ;;
    503) warn "The dashboard is switched off because no operator password is set. Run   sudo bash $APP_DIR/deploy/setup.sh   to set one." ;;
    200) problem "The dashboard opens WITHOUT a password. Run   sudo bash $APP_DIR/deploy/setup.sh --new-password" ;;
    *) warn "The dashboard answered with code \"$code\"." ;;
  esac
  missing_pages=''
  for page in pricing terms privacy refunds shipping contact; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT/$page" 2>/dev/null || true)" = 200 ] || missing_pages="$missing_pages /$page"
  done
  if [ -z "$missing_pages" ]; then
    ok "The pages Razorpay asks for are online (pricing, terms, privacy, refunds, shipping, contact)"
  else
    problem "These pages do not open:$missing_pages. Run   sudo bash $APP_DIR/deploy/setup.sh --yes   to install the site again."
  fi
  if [ "$mode:$test_keys" = razorpay:false ]; then
    missing_details=''
    for key in BUSINESS_NAME SUPPORT_PHONE BUSINESS_ADDRESS SUPPORT_EMAIL; do
      [ -n "$(env_get "$key")" ] || missing_details="$missing_details $key"
    done
    if [ -z "$missing_details" ]; then
      ok "Your business name, phone, address and email are set (they show on the Contact, Terms and Privacy pages)"
    else
      warn "Live payments are on, but these settings are empty, so the Contact page is thin:$missing_details. Run   sudo bash $APP_DIR/deploy/setup.sh   to add them."
    fi
  fi
fi
if [ -n "$(env_get RAZORPAY_WEBHOOK_SECRET)" ]; then
  ok "A webhook secret is set (the webhook itself is created in the Razorpay Dashboard, DEPLOY.md step 8)"
else
  warn "No webhook secret is set. Run   sudo bash $APP_DIR/deploy/setup.sh   to make one."
fi

# ---------------------------------------------------------------------------------------------------------------
step "The address"

if [ -z "$DOMAIN" ]; then
  problem "No website address is saved in $ENV_FILE. Run   sudo bash $APP_DIR/deploy/setup.sh"
else
  server_ip=$(public_ip)
  domain_ip=$(resolve_ipv4 "$DOMAIN")
  if [ -z "$domain_ip" ]; then
    problem "$DOMAIN does not point anywhere yet. In your domain's DNS settings add an A record with the value ${server_ip:-the IP address of this server}."
  elif [ -n "$server_ip" ] && [ "$domain_ip" != "$server_ip" ]; then
    problem "$DOMAIN points to $domain_ip, but this server is $server_ip. Change the A record to $server_ip."
  else
    ok "$DOMAIN points to this server${server_ip:+ ($server_ip)}"
  fi

  if curl -fsS --max-time 8 -o /dev/null "https://$DOMAIN/healthz" 2>/dev/null; then
    ok "https://$DOMAIN works, with a valid certificate"
  elif curl -fsS --max-time 8 -o /dev/null --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" 2>/dev/null; then
    warn "https://$DOMAIN works on this server but not by name. Check the domain's DNS and your hosting company's firewall (ports 80 and 443), then try it from your phone."
  else
    problem "https://$DOMAIN does not work. Caddy's latest messages:   sudo journalctl -u caddy -n 30"
  fi

  redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 8 "http://$DOMAIN/" 2>/dev/null || true)
  case $redirect in
    30[1278]\ https://*) ok "http://$DOMAIN sends visitors on to https://" ;;
    *) warn "http://$DOMAIN did not send visitors on to https:// (it answered: ${redirect:-nothing})." ;;
  esac
fi

# ---------------------------------------------------------------------------------------------------------------
step "The server"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ok "The firewall is on"
else
  warn "The firewall (ufw) is off. Run   sudo bash $APP_DIR/deploy/setup.sh   to turn it on."
fi

if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" = yes ]; then
  ok "The clock is in sync (bookings depend on the right time)"
else
  warn "The clock may not be in sync. Booking times depend on it:   sudo timedatectl set-ntp true"
fi

used=$(df --output=pcent "$STATE_DIR" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)
if [ -z "$used" ]; then
  warn "I could not read the disk usage."
elif [ "$used" -ge 90 ]; then
  problem "The disk is ${used}% full. Free some space soon."
elif [ "$used" -ge 75 ]; then
  warn "The disk is ${used}% full."
else
  ok "The disk is ${used}% full"
fi

latest=$(find "$BACKUP_DIR" -maxdepth 1 -name 'bookings-*.json' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2- || true)
if [ -z "$latest" ]; then
  warn "No backup copy yet. The first one is made tonight. To make one now:   sudo bash $APP_DIR/deploy/backup.sh"
else
  age_hours=$((($(date +%s) - $(stat -c %Y "$latest")) / 3600))
  if [ "$age_hours" -le 48 ]; then
    ok "The latest backup is $age_hours hours old ($(basename "$latest"))"
  else
    problem "The latest backup is $((age_hours / 24)) days old. Look at:   sudo journalctl -u bayfind-backup -n 20"
  fi
fi

if [ "$SHOW_LOGS" = 1 ]; then
  step "The site's log (last 25 lines)"
  journalctl -u bayfind -n 25 --no-pager 2>/dev/null | cut -c1-220 | sed 's/^/  /' || true
fi

printf '\n'
if [ "$PROBLEMS" -eq 0 ]; then
  printf '%sNo problems found.%s Lines marked CHECK are worth a look but are not failures.\n\n' "$GREEN" "$RESET"
  exit 0
fi
printf '%s%s need attention%s (the lines marked PROBLEM above).\n\n' "$RED" "$PROBLEMS" "$RESET"
exit 1
