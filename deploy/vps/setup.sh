#!/usr/bin/env bash
# Voidswarm - one-shot setup for a fresh Ubuntu 24.04 VPS (run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/LawsonMode/voidswarm/main/deploy/vps/setup.sh -o setup.sh
#   sudo DOMAIN=play.aidaho.org EMAIL=you@example.com bash setup.sh
#
# What it does: installs Node 24 + Caddy (automatic HTTPS via Let's Encrypt) + sqlite3, opens only
# SSH/80/443 in the firewall, clones the game to /opt/voidswarm, builds it, runs it as the unprivileged
# 'voidswarm' user under systemd (bound to 127.0.0.1, behind Caddy), keeps the database in
# /var/lib/voidswarm, and installs a nightly database backup. Safe to re-run.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=play.aidaho.org}"
EMAIL="${EMAIL:-}"
REPO="${REPO:-https://github.com/LawsonMode/voidswarm.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/voidswarm
DATA_DIR=/var/lib/voidswarm
ENV_FILE=/etc/voidswarm/voidswarm.env
PORT=7777

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "DOMAIN looks wrong: $DOMAIN" >&2; exit 1; fi

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  echo "==> Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
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
PORT=$PORT
BIND=127.0.0.1
TRUST_PROXY=1
PUBLIC_URL=https://$DOMAIN
CORS_ORIGINS=https://$DOMAIN,https://lawsonmode.github.io
DB_PATH=$DATA_DIR/voidswarm.db
CHAT_FILTER=strict
CHAT_LOG_RETENTION_DAYS=90
# Password-reset email (optional; without it reset links are printed in: journalctl -u voidswarm)
#SMTP_HOST=smtp.gmail.com
#SMTP_PORT=587
#SMTP_USER=you@gmail.com
#SMTP_PASS=your-app-password
#MAIL_FROM="Voidswarm <you@gmail.com>"
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
  echo "  (HTTPS is issued on first visit once the DNS record points here; give it a minute.)"
  echo "  Make yourself a moderator after creating your account in the game:"
  echo "    sudo voidswarm-mod promote <your-username>"
  echo "  Update later:  sudo voidswarm-update     Logs:  journalctl -u voidswarm -f"
else
  echo "The service did not start - see: journalctl -u voidswarm -n 50" >&2
  exit 1
fi
