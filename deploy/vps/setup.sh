#!/usr/bin/env bash
# Voidswarm - one-shot setup for a fresh Ubuntu 24.04 VPS (run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/LawsonMode/voidswarm/main/deploy/vps/setup.sh -o setup.sh
#   sudo DOMAIN=play.aidaho.org EMAIL=you@example.com TZ=America/Boise bash setup.sh
#
# What it does: checks first that this server can reach GitHub over IPv4 and that DOMAIN already points
# here, adds a 2 GB swap file on small (under 2 GB RAM) plans, optionally sets the time zone, then installs
# Node 24 + Caddy (automatic HTTPS via Let's Encrypt) + sqlite3, opens only SSH/80/443 in the firewall,
# clones the game to /opt/voidswarm, builds it, runs it as the unprivileged 'voidswarm' user under systemd
# (bound to 127.0.0.1, behind Caddy), keeps the database in /var/lib/voidswarm, and installs a nightly
# database backup. Safe to re-run.
#
# Settings (only DOMAIN is required):
#   DOMAIN=play.aidaho.org  the address players use; its DNS A record must already point at this server
#   EMAIL=you@example.com   optional contact address for the HTTPS certificate account (Caddy renews the
#                           certificate by itself; Let's Encrypt no longer sends expiry emails)
#   TZ=America/Boise        set the server's time zone (the nightly backup runs at 03:17 in it). Without
#                           TZ the server's zone is left as it is (UTC on most cloud images).
#   SKIP_DNS_CHECK=1        skip the "DOMAIN points at this server" check (only if you're sure it does)
#   REPO=... BRANCH=...     install from another git repo / branch
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=play.aidaho.org}"
EMAIL="${EMAIL:-}"
REPO="${REPO:-https://github.com/LawsonMode/voidswarm.git}"
BRANCH="${BRANCH:-main}"
TZ_NAME="${TZ:-}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-}"
APP_DIR=/opt/voidswarm
DATA_DIR=/var/lib/voidswarm
ENV_FILE=/etc/voidswarm/voidswarm.env
PORT=7777
IP_CHECK_URL=https://checkip.amazonaws.com
ZONEINFO=/usr/share/zoneinfo
MEMINFO=/proc/meminfo
FSTAB=/etc/fstab
SWAPFILE=/swapfile
SWAP_MB=2048
SWAP_SYSCTL=/etc/sysctl.d/60-voidswarm-swap.conf
# "Under 2 GB of RAM": a 2 GB plan reports a little less than 2 GB (the kernel keeps some for itself), so
# the cutoff is 1.8 GB. 1 GB and 512 MB plans get swap; 2 GB and bigger plans are left alone.
SWAP_BELOW_KB=$((1800 * 1024))

# ---- helpers ----

# Stop with a plain-language explanation: the first argument is the headline, each further one a line.
fail() {
  local line
  printf '\nSTOPPED: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

is_ipv4() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# The host name inside a git URL (https://host/..., ssh://user@host/..., user@host:path); github.com otherwise.
repo_host() {
  if [[ $1 =~ ^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@)?([^/:]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
  elif [[ $1 =~ ^[^/@:]+@([^/:]+): ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf 'github.com\n'
  fi
}

# A newline-separated list as "a, b", or a note when it's empty.
join_list() {
  local out='' item
  while IFS= read -r item; do
    if [[ -n $item ]]; then out+="${out:+, }$item"; fi
  done <<<"$1"
  printf '%s' "${out:-nothing yet (no A record found)}"
}

# Keep only the IPv4 addresses from a lookup's output (dig +short also prints CNAMEs and ";;" error lines),
# minus 127.x (getent also reads /etc/hosts, which may map this machine's own name to 127.x).
ipv4_lines() { grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | grep -v '^127\.' | sort -u || true; }

# Keep only the IPv6 addresses (IPv4-mapped answers like ::ffff:1.2.3.4 are not AAAA records), minus ::1.
ipv6_lines() { grep -iE '^[0-9a-f:]+$' | grep -v '^::1$' | sort -u || true; }

# True when every address in the list is private (10/8, 172.16/12, 192.168/16, 100.64/10) and it isn't empty.
all_private() {
  local ip n=0
  while IFS= read -r ip; do
    if [[ -z $ip ]]; then continue; fi
    n=$((n + 1))
    [[ $ip =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]] || return 1
  done <<<"$1"
  (( n > 0 ))
}

# DNS resolvers to ask, in order. Public ones first: they see the record the way Let's Encrypt does. A
# cloud provider's own resolver can differ (on EC2 it answers AWS host names with private addresses, and it
# may still remember an earlier "no such name"). '' = this server's own resolver, the fallback.
DNS_RESOLVERS=(1.1.1.1 8.8.8.8 '')

# One resolver's answers for a record type. Returns 1 when that resolver couldn't be asked or didn't
# reply (dig missing, timed out, or only ";;" error text); a reply with no records prints nothing.
dig_answers() {
  local type=$1 name=$2 server=$3 out
  if ! command -v dig >/dev/null 2>&1; then return 1; fi
  if [[ -n $server ]]; then
    out=$(dig +short +time=3 +tries=2 "@$server" "$type" "$name" 2>/dev/null) || return 1
  else
    out=$(dig +short +time=3 +tries=2 "$type" "$name" 2>/dev/null) || return 1
  fi
  if [[ -n $out ]] && ! grep -qv '^;;' <<<"$out"; then return 1; fi
  if [[ -n $out ]]; then printf '%s\n' "$out"; fi
}

# The IPv4 addresses (A records) a name has right now: sorted, one per line, empty if none.
# Asks each resolver in DNS_RESOLVERS in turn. With a second argument (an address), the first answer that
# is exactly that address wins, since a public cache can lag behind a record that was just added.
# Otherwise, or if none matches, the first resolver that replied wins. The system lookup (getent, which
# also reads /etc/hosts) is the last resort, used only when no resolver could be asked at all.
dns_ipv4() {
  local name=$1 want=${2:-} server ips first='' replied=0
  resolvectl flush-caches >/dev/null 2>&1 || true
  for server in "${DNS_RESOLVERS[@]}"; do
    ips=$(dig_answers A "$name" "$server" | ipv4_lines) || continue
    if (( ! replied )); then first=$ips replied=1; fi
    if [[ -z $want || $ips == "$want" ]]; then
      first=$ips
      break
    fi
  done
  if (( ! replied )); then
    first=$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | ipv4_lines || true)
  fi
  if [[ -n $first ]]; then printf '%s\n' "$first"; fi
}

# The IPv6 addresses (AAAA records) a name has, one per line: the first resolver that replies wins.
dns_ipv6() {
  local name=$1 server raw
  for server in "${DNS_RESOLVERS[@]}"; do
    if raw=$(dig_answers AAAA "$name" "$server"); then
      ipv6_lines <<<"$raw"
      return 0
    fi
  done
  getent ahostsv6 "$name" 2>/dev/null | awk '{print $1}' | ipv6_lines || true
}

# This machine's own global IPv6 addresses, one per line.
local_ipv6() {
  ip -6 -o addr show scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }' || true
}

meminfo_kb() {
  awk -v key="$1:" '$1 == key { print $2; found = 1 } END { if (!found) print 0 }' "$MEMINFO"
}

# TZ must be a zone name this server knows, e.g. America/Boise. Checked before anything is changed.
check_timezone_name() {
  TZ_NAME="${TZ_NAME#:}"
  TZ_NAME="${TZ_NAME#"$ZONEINFO"/}"
  # TZ=:/etc/localtime (set by some shells) just means "the system's zone": same as no TZ.
  if [[ $TZ_NAME == /etc/localtime ]]; then TZ_NAME=''; fi
  if [[ -z $TZ_NAME ]]; then return 0; fi
  if ! [[ $TZ_NAME =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] || [[ ! -f "$ZONEINFO/$TZ_NAME" ]]; then
    fail "TZ=$TZ_NAME isn't a time zone name this server knows." \
      "Use a name like America/Boise, America/Denver or America/Los_Angeles (capitals matter)." \
      "See them all with: timedatectl list-timezones" \
      "Or leave TZ out to keep the server's current time zone."
  fi
}

apply_timezone() {
  local current
  current=$(timedatectl show --property=Timezone --value 2>/dev/null || true)
  if [[ -z $TZ_NAME ]]; then
    echo "==> Time zone: left as it is (${current:-unknown}). Add TZ=America/Boise to the command to change it."
    return 0
  fi
  if [[ $current == "$TZ_NAME" ]]; then
    echo "==> Time zone: already $TZ_NAME"
    return 0
  fi
  echo "==> Time zone: ${current:-unknown} -> $TZ_NAME"
  if command -v timedatectl >/dev/null 2>&1; then
    timedatectl set-timezone "$TZ_NAME"
  else
    ln -sf "$ZONEINFO/$TZ_NAME" /etc/localtime
    printf '%s\n' "$TZ_NAME" >/etc/timezone
  fi
  # cron reads the time zone when it starts; restart it so the nightly backup follows the new zone.
  systemctl try-restart cron.service >/dev/null 2>&1 || true
}

# curl and dig (bind9-dnsutils) are needed for the checks; most images already have both.
ensure_check_tools() {
  local pkgs=()
  if ! command -v curl >/dev/null 2>&1; then pkgs+=(curl ca-certificates); fi
  if ! command -v dig >/dev/null 2>&1; then pkgs+=(bind9-dnsutils); fi
  if (( ${#pkgs[@]} == 0 )); then return 0; fi
  echo "    installing ${pkgs[*]} (needed for the checks)"
  apt-get update -y >/dev/null
  apt-get install -y "${pkgs[@]}" >/dev/null
}

# GitHub has no IPv6 address, so the code can only be fetched over IPv4 (and IPv4-only players need it too).
preflight_github() {
  local host
  host=$(repo_host "$REPO")
  if curl -4 -sS -o /dev/null --connect-timeout 10 --max-time 20 "https://$host/" 2>/dev/null; then
    echo "    $host is reachable over IPv4"
    return 0
  fi
  fail "This server can't reach $host over IPv4." \
    "GitHub has no IPv6 address, so the game can only be downloaded over IPv4, and players on" \
    "IPv4-only networks couldn't reach the server either." \
    "On Amazon Lightsail, use a dual-stack plan (one with a public IPv4 address), not an \"IPv6-only\"" \
    "plan: make a snapshot and create a dual-stack instance from it, or just start a new one." \
    "Elsewhere, pick a plan that includes a public IPv4 address." \
    "If this server does have IPv4, check its outbound network / firewall rules and run this again."
}

# DOMAIN must already point at this server: Caddy asks Let's Encrypt for a certificate as soon as it starts.
preflight_dns() {
  local my_ip a_list aaaa_list local6 addr extra6=''
  if [[ $SKIP_DNS_CHECK == 1 ]]; then
    echo "    DNS check skipped (SKIP_DNS_CHECK=1)"
    return 0
  fi
  my_ip=$(curl -4 -fsS --connect-timeout 10 --max-time 15 "$IP_CHECK_URL" 2>/dev/null | tr -d '[:space:]' || true)
  if ! is_ipv4 "$my_ip"; then
    fail "Couldn't look up this server's public IPv4 address (asked $IP_CHECK_URL)." \
      "It's needed to check that $DOMAIN points here. Try again in a minute. If you're sure the DNS" \
      "record is right, run the same command with SKIP_DNS_CHECK=1 added after sudo."
  fi
  a_list=$(dns_ipv4 "$DOMAIN" "$my_ip")
  if [[ $a_list != "$my_ip" ]]; then
    local private_note=()
    if all_private "$a_list"; then
      private_note=("That's a private address, which works only inside the provider's own network. Use the" \
        "public address above instead (not the \"private IP\" shown in the provider's console, and not a" \
        "CNAME to the provider's own host name)." "")
    fi
    fail "$DOMAIN doesn't point at this server yet." \
      "This server's public IPv4 address:  $my_ip" \
      "$DOMAIN points to:  $(join_list "$a_list")" \
      "" \
      "${private_note[@]}" \
      "Why this stops here: as soon as Caddy starts, it asks Let's Encrypt for the HTTPS certificate," \
      "and Let's Encrypt checks by visiting $DOMAIN. If the name points somewhere else, that fails." \
      "After a few failures Let's Encrypt refuses the name for a while (its rate limits), so HTTPS" \
      "would stay broken even after the DNS is fixed." \
      "" \
      "Fix: at your DNS provider, give $DOMAIN a single A record pointing to $my_ip." \
      "(On Lightsail, attach a static IP to the instance first and use that address.)" \
      "Wait until it shows up, then run the same command again. To see what the internet sees, run" \
      "this on the server:  dig +short $DOMAIN @1.1.1.1   (on Windows: Resolve-DnsName $DOMAIN)" \
      "Nothing has been set up yet in this run." \
      "Already sure the DNS is right? Add SKIP_DNS_CHECK=1 after sudo to skip this check."
  fi
  echo "    $DOMAIN points to $my_ip (this server)"

  aaaa_list=$(dns_ipv6 "$DOMAIN")
  if [[ -z $aaaa_list ]]; then return 0; fi
  local6=$(local_ipv6)
  while IFS= read -r addr; do
    if [[ -n $addr ]] && ! grep -qixF -- "$addr" <<<"$local6"; then extra6+="${extra6:+, }$addr"; fi
  done <<<"$aaaa_list"
  if [[ -n $extra6 ]]; then
    fail "$DOMAIN also has an IPv6 (AAAA) record that isn't this server: $extra6" \
      "Let's Encrypt tries IPv6 first, so the certificate check would go to that address and fail," \
      "with the same rate-limit problem as a wrong A record." \
      "Fix: delete the AAAA record for $DOMAIN at your DNS provider (only the A record is needed)," \
      "wait for it to disappear, then run the same command again." \
      "Already sure it's right? Add SKIP_DNS_CHECK=1 after sudo to skip this check."
  fi
  echo "    $DOMAIN also has an IPv6 record for this server: allow 80 and 443 on the IPv6 firewall too"
}

# The provider's own firewall (in its web console) sits in front of this server's ufw.
firewall_reminder() {
  echo "  Cloud firewall: your provider has its own firewall in front of this server. It must allow"
  echo "  TCP 80 (HTTP) and 443 (HTTPS) from anywhere, or the HTTPS certificate can't be issued:"
  echo "    - Amazon Lightsail: the instance's Networking tab. Add HTTPS (443); it's closed by default."
  echo "      Add it on the IPv6 firewall too (or remove the IPv6 rules)."
  echo "    - Amazon EC2: the instance's security group (inbound rules for 80 and 443)."
  echo "  Never open port 7777 there: the game listens only on 127.0.0.1, behind Caddy."
  echo "  If https://$DOMAIN times out, a closed port 443 is the usual reason."
}

# Small plans (under 2 GB RAM) can run out of memory while npm installs and builds the game, so give them a
# 2 GB swap file. Does nothing if any swap is already on. Re-runs reuse the existing file.
ensure_swap() {
  local mem_kb swap_kb avail_kb made=0
  mem_kb=$(meminfo_kb MemTotal)
  swap_kb=$(meminfo_kb SwapTotal)
  if (( swap_kb > 0 )); then
    echo "==> Swap: already on ($((swap_kb / 1024)) MB)"
    return 0
  fi
  if (( mem_kb >= SWAP_BELOW_KB )); then
    echo "==> Swap: not needed ($((mem_kb / 1024)) MB of RAM)"
    return 0
  fi
  echo "==> Swap: $((mem_kb / 1024)) MB of RAM and no swap, adding a $((SWAP_MB / 1024)) GB swap file ($SWAPFILE)"
  if [[ ! -f $SWAPFILE ]]; then
    avail_kb=$(df -Pk "$(dirname "$SWAPFILE")" | awk 'NR == 2 { print $4 }')
    if (( avail_kb < (SWAP_MB + 1024) * 1024 )); then
      echo "warning: not enough free disk space for a swap file; continuing without one" >&2
      return 0
    fi
    made=1
    if ! fallocate -l "${SWAP_MB}M" "$SWAPFILE" 2>/dev/null; then
      if ! dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAP_MB" status=none; then
        echo "warning: couldn't create the swap file; continuing without one" >&2
        rm -f -- "$SWAPFILE" 2>/dev/null || true
        return 0
      fi
    fi
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null 2>&1 || true
  fi
  chmod 600 "$SWAPFILE"
  if ! swapon "$SWAPFILE" 2>/dev/null; then
    # A file left half-made by an interrupted run (it has exactly the size this script makes): format it
    # once more and retry. Any other file at that path isn't ours, so it's left alone.
    if (( ! made )) && [[ $(stat -c %s -- "$SWAPFILE" 2>/dev/null || echo 0) != "$((SWAP_MB * 1024 * 1024))" ]]; then
      echo "warning: $SWAPFILE already exists but isn't a working swap file; leaving it alone and continuing" >&2
      echo "         without swap. To let this script make one, remove it (sudo rm $SWAPFILE) and run it again." >&2
      return 0
    fi
    if ! { mkswap -f "$SWAPFILE" >/dev/null 2>&1 && swapon "$SWAPFILE" 2>/dev/null; }; then
      echo "warning: couldn't turn on the swap file (some hosts don't allow swap); continuing without it" >&2
      if (( made )); then rm -f -- "$SWAPFILE" 2>/dev/null || true; fi
      return 0
    fi
  fi
  if ! grep -qE "^[[:space:]]*$SWAPFILE[[:space:]]" "$FSTAB"; then
    printf '%s none swap sw 0 0\n' "$SWAPFILE" >>"$FSTAB"
  fi
  # Use swap only when memory is really short, so the game itself stays in RAM.
  printf 'vm.swappiness=10\n' >"$SWAP_SYSCTL"
  sysctl -q -w vm.swappiness=10 >/dev/null 2>&1 || true
}

# ---- end helpers ----

main() {
  if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
  if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "DOMAIN looks wrong: $DOMAIN" >&2; exit 1; fi
  export DEBIAN_FRONTEND=noninteractive

  echo "==> Checks before installing"
  check_timezone_name
  ensure_check_tools
  preflight_github
  preflight_dns
  echo
  echo "  Before the install gets to HTTPS (in a few minutes), check this:"
  firewall_reminder
  echo

  ensure_swap
  apply_timezone

  echo "==> Packages"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https

  if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
    echo "==> Node.js 24 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  fi

  if ! command -v caddy >/dev/null; then
    echo "==> Caddy"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi

  echo "==> Firewall (SSH, HTTP, HTTPS only)"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null

  echo "==> User + folders"
  id voidswarm >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin voidswarm
  install -d -o voidswarm -g voidswarm -m 750 "$DATA_DIR" "$DATA_DIR/backups"
  install -d -m 750 /etc/voidswarm

  echo "==> Code"
  if [[ -d "$APP_DIR/.git" ]]; then
    sudo -u voidswarm git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    sudo -u voidswarm git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
  else
    install -d -o voidswarm -g voidswarm "$APP_DIR"
    sudo -u voidswarm git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
  fi
  cd "$APP_DIR"
  sudo -u voidswarm env HOME="$APP_DIR" npm ci --no-audit --no-fund
  sudo -u voidswarm env HOME="$APP_DIR" npm run build

  echo "==> Settings ($ENV_FILE)"
  if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" <<EOF
# Voidswarm server settings. Edit, then: sudo systemctl restart voidswarm
# One NAME=value per line. Comments go on their own line, starting with #.
# Put double quotes around any value that contains spaces, like the MAIL_FROM examples below.
# Inside double quotes, put a backslash in front of any double quote or backslash in the value.
PORT=$PORT
BIND=127.0.0.1
TRUST_PROXY=1
PUBLIC_URL=https://$DOMAIN
CORS_ORIGINS=https://$DOMAIN,https://lawsonmode.github.io
DB_PATH=$DATA_DIR/voidswarm.db
CHAT_FILTER=strict
CHAT_LOG_RETENTION_DAYS=90

# Password-reset email (optional). Without it, reset links are printed in: journalctl -u voidswarm
# To turn it on, pick ONE example, remove the # in front of its lines, fill in your details, then restart.
# Use port 587: AWS (and many other hosts) block port 25.
#
# a) A mailbox you already have: an address at your own domain (your mail host tells you its SMTP
#    server name) or Gmail with an app password.
#SMTP_HOST=smtp.example.com
#SMTP_PORT=587
#SMTP_USER=noreply@example.com
#SMTP_PASS="the mailbox password"
#MAIL_FROM="Voidswarm <noreply@example.com>"
#
# b) Amazon SES in Oregon (verify your domain with DKIM and get production access first).
#    The user name and password are the SES "SMTP credentials", not your AWS login.
#SMTP_HOST=email-smtp.us-west-2.amazonaws.com
#SMTP_PORT=587
#SMTP_USER=your-SES-SMTP-user-name
#SMTP_PASS="your-SES-SMTP-password"
#MAIL_FROM="Voidswarm <noreply@example.com>"

# Off-box copy of each nightly database backup (optional; details at the top of: /usr/local/bin/voidswarm-backup)
#BACKUP_REMOTE=s3://your-bucket/voidswarm/
#BACKUP_REMOTE=backupuser@203.0.113.20:/srv/backups/voidswarm/
EOF
  fi
  chown root:voidswarm "$ENV_FILE"
  chmod 640 "$ENV_FILE"

  echo "==> systemd service"
  install -m 644 "$APP_DIR/deploy/vps/voidswarm.service" /etc/systemd/system/voidswarm.service
  systemctl daemon-reload
  systemctl enable --now voidswarm
  systemctl restart voidswarm

  echo "==> Caddy (HTTPS for $DOMAIN)"
  {
    if [[ -n "$EMAIL" ]]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
    sed "s/{\$DOMAIN}/$DOMAIN/g" "$APP_DIR/deploy/vps/Caddyfile"
  } > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable --now caddy
  systemctl reload caddy

  echo "==> Helpers + nightly backup"
  install -m 755 "$APP_DIR/deploy/vps/voidswarm-mod" /usr/local/bin/voidswarm-mod
  install -m 755 "$APP_DIR/deploy/vps/update.sh" /usr/local/bin/voidswarm-update
  install -m 755 "$APP_DIR/deploy/vps/backup.sh" /usr/local/bin/voidswarm-backup
  echo "17 3 * * * root /usr/local/bin/voidswarm-backup" > /etc/cron.d/voidswarm-backup
  chmod 644 /etc/cron.d/voidswarm-backup

  sleep 2
  if systemctl is-active --quiet voidswarm; then
    echo
    echo "Voidswarm is running.  Open: https://$DOMAIN"
    echo "  (Caddy asked for the HTTPS certificate when it started; it's usually ready within a minute.)"
    echo "  Make yourself a moderator after creating your account in the game:"
    echo "    sudo voidswarm-mod promote <your-username>"
    echo "  Update later:  sudo voidswarm-update     Logs:  journalctl -u voidswarm -f"
    echo "  Nightly database backup: 03:17 server time ($(timedatectl show --property=Timezone --value 2>/dev/null || echo 'system zone'))"
    echo
    firewall_reminder
  else
    echo "The service did not start - see: journalctl -u voidswarm -n 50" >&2
    echo
    firewall_reminder
    exit 1
  fi
}

main "$@"
