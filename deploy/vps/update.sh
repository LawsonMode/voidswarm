#!/usr/bin/env bash
# Voidswarm - update the VPS to the latest code on GitHub and restart (run as root: sudo voidswarm-update).
set -euo pipefail
APP_DIR=/opt/voidswarm
BRANCH="${BRANCH:-main}"
if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi

/usr/local/bin/voidswarm-backup || echo "warning: the backup step reported a problem (see above), continuing" >&2
cd "$APP_DIR"
before=$(sudo -u voidswarm git rev-parse --short HEAD)
sudo -u voidswarm git fetch --quiet origin "$BRANCH"
sudo -u voidswarm git reset --quiet --hard "origin/$BRANCH"
after=$(sudo -u voidswarm git rev-parse --short HEAD)
sudo -u voidswarm env HOME="$APP_DIR" npm ci --no-audit --no-fund
sudo -u voidswarm env HOME="$APP_DIR" npm run build
install -m 644 deploy/vps/voidswarm.service /etc/systemd/system/voidswarm.service
install -m 755 deploy/vps/voidswarm-mod /usr/local/bin/voidswarm-mod
install -m 755 deploy/vps/update.sh /usr/local/bin/voidswarm-update
install -m 755 deploy/vps/backup.sh /usr/local/bin/voidswarm-backup
systemctl daemon-reload
systemctl restart voidswarm
sleep 2
systemctl is-active --quiet voidswarm && echo "Updated $before -> $after and restarted." || { echo "Service failed - journalctl -u voidswarm -n 50" >&2; exit 1; }
