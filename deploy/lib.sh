#!/usr/bin/env bash
# Shared by setup.sh and check.sh. It only defines things, so running it by itself does nothing.
# shellcheck disable=SC2034  # some names are used only by the scripts that load this file

# ---- Where everything lives on the server -------------------------------------------------------------------
# The BAYFIND_* names exist only so the scripts can be tested without touching the real folders.
# On a real server you never set them.
APP_DIR="${BAYFIND_APP_DIR:-/opt/bayfind}"           # the site's program files; replaced by every update
CONF_DIR="${BAYFIND_CONF_DIR:-/etc/bayfind}"         # your settings and secrets
ENV_FILE="$CONF_DIR/bayfind.env"
STATE_DIR="${BAYFIND_STATE_DIR:-/var/lib/bayfind}"   # bookings.json lives here
BACKUP_DIR="${BAYFIND_BACKUP_DIR:-/var/backups/bayfind}"
SYSTEMD_DIR="${BAYFIND_SYSTEMD_DIR:-/etc/systemd/system}"
CADDYFILE="${BAYFIND_CADDYFILE:-/etc/caddy/Caddyfile}"
SERVICE_USER="bayfind"

# ---- Messages ---------------------------------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %sOK%s       %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %sCHECK%s    %s\n' "$YELLOW" "$RESET" "$*"; }
bad()  { printf '  %sPROBLEM%s  %s\n' "$RED" "$RESET" "$*"; }
die()  { printf '\n%sStopped:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---- The settings file (/etc/bayfind/bayfind.env) -----------------------------------------------------------
# One KEY="value" per line. Both systemd and these scripts read it. Values never contain a quote, a backslash or a
# line break (env_set refuses them), so no escaping is ever needed.

# env_get KEY  ->  prints the value ("" when missing)
env_get() {
  local line
  [ -f "$ENV_FILE" ] || return 0
  line=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1) || true
  line=${line#*=}
  line=${line#\"}
  line=${line%\"}
  printf '%s' "$line"
}

# env_set KEY VALUE  ->  replaces that line (or adds it) and leaves every other line as it was
env_set() {
  local key=$1 value=$2 tmp
  case $value in
    *'"'* | *\\* | *$'\n'*) die "The value for $key contains a quote, a backslash or a line break, which the settings file cannot hold." ;;
  esac
  [ -f "$ENV_FILE" ] || install -m 600 /dev/null "$ENV_FILE"
  tmp=$(mktemp "$CONF_DIR/.bayfind-env.XXXXXX")
  KEY="$key" VAL="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=\"" v "\""; done = 1 } ; next }
    { print }
    END { if (!done) print k "=\"" v "\"" }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# ---- Checking what was typed ---------------------------------------------------------------------------------------
# Every check takes the value as $1 and succeeds when it can be used.
RE_DOMAIN='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$'
RE_KEY_ID='^rzp_(test|live)_[A-Za-z0-9]{6,40}$'
RE_EMAIL='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
RE_PHONE='^[0-9+() -]{6,30}$'

has_space_or_quote() {
  case $1 in
    *[[:space:]]* | *'"'* | *\\*) return 0 ;;
  esac
  return 1
}
has_quote_or_control() {
  case $1 in
    *'"'* | *\\* | *[[:cntrl:]]*) return 0 ;;
  esac
  return 1
}

valid_domain()    { [[ $1 =~ $RE_DOMAIN ]]; }
valid_key_id()    { [ -z "$1" ] || [[ $1 =~ $RE_KEY_ID ]]; }
valid_secret()    { [ -z "$1" ] || { [ "${#1}" -ge 8 ] && [ "${#1}" -le 100 ] && ! has_space_or_quote "$1"; }; }
valid_password()  { [ "${#1}" -ge 12 ] && [ "${#1}" -le 100 ] && ! has_space_or_quote "$1"; }
valid_site_name() { [ "${#1}" -ge 1 ] && [ "${#1}" -le 40 ] && ! has_quote_or_control "$1"; }
valid_email()     { [ -z "$1" ] || { [[ $1 =~ $RE_EMAIL ]] && ! has_space_or_quote "$1"; }; }
valid_business_name() { [ "${#1}" -le 80 ] && ! has_quote_or_control "$1"; }
valid_phone()     { [ -z "$1" ] || [[ $1 =~ $RE_PHONE ]]; }
valid_address()   { [ "${#1}" -le 240 ] && ! has_quote_or_control "$1"; }

# "https://Parking.Example.com/" -> "parking.example.com"
clean_domain() {
  local d=${1,,}
  d=${d#http://}
  d=${d#https://}
  d=${d%%/*}
  d=${d%%:*}
  printf '%s' "$d"
}

# random_string LENGTH  ->  letters and digits only
random_string() {
  head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c "1-$1"
}

# ---- Asking questions -----------------------------------------------------------------------------------------------
ASSUME_YES=0   # --yes: ask nothing, keep the current settings
ASK_EOF=0      # becomes 1 when there is nobody left to answer (input ended)

# ask VAR "Question" [default] [secret] [hint]
# Puts the answer in the variable named VAR. A BAYFIND_VAR environment variable answers it without asking.
# Pass any non-empty 4th argument for a secret (what is typed is not shown). The hint line is worked out from the
# default unless a 5th argument gives one.
ask() {
  local var=$1 question=$2 default=${3-} secret=${4-} hint=${5-} override="BAYFIND_$1" answer=''
  if [ -n "${!override-}" ]; then
    printf -v "$var" '%s' "${!override}"
    return 0
  fi
  if [ "$ASSUME_YES" = 1 ]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  if [ -z "$hint" ]; then
    if [ -z "$default" ]; then
      hint='Press Enter to skip.'
    elif [ -n "$secret" ]; then
      hint='Press Enter to keep the one you have now.'
    else
      hint="Press Enter to keep: $default"
    fi
  fi
  printf '\n%s\n  %s\n  > ' "$question" "$hint"
  if [ -n "$secret" ]; then
    IFS= read -rs answer || ASK_EOF=1
    printf '\n'
  else
    IFS= read -r answer || ASK_EOF=1
  fi
  answer=${answer//$'\r'/}
  [ -n "$answer" ] || answer=$default
  printf -v "$var" '%s' "$answer"
}

# ask_valid VAR "Question" default check-function "what to tell the person when it is not valid" [secret]
ask_valid() {
  local var=$1 question=$2 default=$3 check=$4 message=$5 secret=${6-} override="BAYFIND_$1"
  while :; do
    ask "$var" "$question" "$default" "$secret"
    if "$check" "${!var}"; then return 0; fi
    bad "$message"
    # Nobody can type a better answer when it came from --yes or from a BAYFIND_ variable, or when the input ended.
    if [ "$ASSUME_YES" = 1 ] || [ -n "${!override-}" ] || [ "$ASK_EOF" = 1 ]; then die "That setting cannot be used."; fi
  done
}

# yes_no "Question" y|n  ->  succeeds for yes. Asks nothing with --yes.
# When the input has ended there is nobody to say yes, so the answer is no (whatever the default is).
yes_no() {
  local question=$1 default=$2 answer='' shown='[y/N]'
  [ "$default" = y ] && shown='[Y/n]'
  if [ "$ASSUME_YES" = 1 ]; then [ "$default" = y ]; return; fi
  printf '\n%s %s ' "$question" "$shown"
  IFS= read -r answer || ASK_EOF=1
  answer=${answer//$'\r'/}
  answer=${answer,,}
  if [ -z "$answer" ]; then
    if [ "$ASK_EOF" = 1 ]; then printf '\n'; return 1; fi
    answer=$default
  fi
  [ "${answer:0:1}" = y ]
}

# ---- The network ------------------------------------------------------------------------------------------------------
# This server's public IPv4 address (empty when it cannot be found).
public_ip() {
  local url ip
  if [ -n "${BAYFIND_PUBLIC_IP-}" ]; then printf '%s' "$BAYFIND_PUBLIC_IP"; return 0; fi
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
    if [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then printf '%s' "$ip"; return 0; fi
  done
}

# The IPv4 address a name points to (empty when it points nowhere yet).
resolve_ipv4() {
  getent ahostsv4 "$1" 2>/dev/null | awk 'NR == 1 { print $1 }' || true
}

# wait_for URL SECONDS [more curl options]  ->  succeeds once the address answers with a success status
wait_for() {
  local url=$1 seconds=$2 i
  shift 2
  for ((i = 0; i < seconds; i++)); do
    if curl -fsS --max-time 3 -o /dev/null "$@" "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# json_get a.b.c  ->  reads JSON on stdin and prints that field (nothing when it is missing)
json_get() {
  node -e 'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => { try { const v = process.argv[1].split(".").reduce((o, k) => o[k], JSON.parse(s)); if (v !== undefined && v !== null) console.log(String(v)); } catch (e) {} });' "$1"
}
