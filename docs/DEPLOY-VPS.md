# Always-on server on a VPS (e.g. play.aidaho.org)

This runs the whole game on a small cloud server, around the clock, whether your PC is on or not: the game page, multiplayer, accounts, loot, the chat log and `/admin`. Your existing website and email are untouched; you only add one DNS record.

**Cost:** it depends on the provider and the plan size. For Amazon Lightsail the recommended plan is $12/month, and new AWS accounts get free credits; [DEPLOY-AWS.md](DEPLOY-AWS.md) has the full cost table (measured traffic for casual, active and busy servers) and a click-by-click guide.

**Size:** 2 GB of RAM is comfortable. 1 GB works for casual play, because `setup.sh` adds a swap file on plans with less than 2 GB. Whatever you pick, it must include a **public IPv4 address** (not "IPv6-only").

## 1. Create the server (about 5 minutes)

Pick a provider. Hetzner Cloud, DigitalOcean and Amazon Lightsail all work.

**On Amazon Lightsail, follow [DEPLOY-AWS.md](DEPLOY-AWS.md) instead.** It covers the steps only AWS needs: the account plan, a static IP, the extra firewall and snapshots.

1. Create an **Ubuntu 24.04** server.
   - Hetzner: the smallest shared plan (CPX11 or CAX11). Pick the **Hillsboro, OR** location if it's offered, since it's close to Idaho.
2. Add your **SSH key** during creation. It's safer than a password.
3. Note the server's **public IPv4 address**, for example `203.0.113.10`.

## 2. Point play.aidaho.org at it (Network Solutions)

1. Log in to Network Solutions and go to **Domains → aidaho.org → Manage DNS / Advanced DNS Records**.
2. **Add an A record:**
   - Host: `play`
   - Points to: your server's IPv4
   - TTL: the lowest offered (e.g. 1 hour)
3. Leave every existing record alone, especially the `@`/`www` records (your website) and the MX records (your email).
4. Wait until it resolves:

   ```powershell
   Resolve-DnsName play.aidaho.org
   ```

   It should show your server's IP. That's usually minutes, sometimes an hour or two.

## 3. Install the game (one command)

Connect from your PC. **The user name depends on the provider:**
- **AWS (Lightsail or EC2):** `ssh ubuntu@<server-ip>` (with the key file: see [DEPLOY-AWS.md](DEPLOY-AWS.md)).
- **Hetzner, DigitalOcean and most others:** `ssh root@<server-ip>`.
- If neither works, the provider's page for the server says which user to use.

Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/LawsonMode/voidswarm/main/deploy/vps/setup.sh -o setup.sh
sudo DOMAIN=play.aidaho.org EMAIL=you@example.com TZ=America/Boise bash setup.sh
```

- `EMAIL` (optional) is the contact address on the HTTPS certificate account. Caddy renews the certificate by itself, so there's nothing to watch for (Let's Encrypt stopped sending expiry emails in 2025).
- `TZ` (optional) sets the server's time zone, so the nightly backup runs at 3:17 am your time. Without it, the server keeps its current zone (usually UTC on cloud servers, which puts the backup at about 9:17 pm in Idaho).

When the script finishes, open **https://play.aidaho.org**. Caddy gets the HTTPS certificate as soon as it starts; it's usually ready within a minute.

**Checks first.** Before it installs anything, `setup.sh` checks four things and stops with a plain explanation if one fails:
- The server can reach GitHub over IPv4. GitHub has no IPv6 address, so an IPv6-only plan can't download the game.
- `play.aidaho.org` already points at this server. If it doesn't, Let's Encrypt would fail to issue the certificate, and after a few failures it refuses the name for a while. Fix the DNS record and run the same command again. To see what the internet sees, run `dig +short play.aidaho.org @1.1.1.1` on the server. (If you're sure the DNS is right, add `SKIP_DNS_CHECK=1` after `sudo`.)
- No IPv6 (AAAA) record points somewhere else. If one does, delete it; only the A record is needed.
- The `TZ` name, if you gave one, is a real time zone (for example `America/Boise`).

What `setup.sh` sets up:
- **Memory:** on plans with less than 2 GB of RAM, a 2 GB swap file, so installs and updates can't run out of memory.
- **Software:** Node 24, Caddy (automatic HTTPS and WebSockets) and sqlite3.
- **Firewall:** only SSH, 80 and 443 are open. Cloud providers often have a second firewall in their web console: it must allow 80 and 443 too, and never 7777. The script reminds you before it installs anything and again at the end.
- **The game:** cloned to `/opt/voidswarm`, built, and run as the restricted `voidswarm` user. It listens on `127.0.0.1` only, behind Caddy, with `systemd` restarting it if it stops.
- **Data:** accounts, loot and chat log live in `/var/lib/voidswarm/voidswarm.db`, backed up nightly to `/var/lib/voidswarm/backups/` with 14 days kept. See [Backups](#backups) for keeping a copy somewhere else.
- **Settings:** in `/etc/voidswarm/voidswarm.env`, covering the chat-filter strictness, log retention, optional SMTP for password-reset email and the optional off-box backup copy. Values that contain spaces must be in double quotes, for example `MAIL_FROM="Voidswarm <noreply@example.com>"`.

It's safe to run `setup.sh` again: it skips what's already done and keeps your settings file.

## 4. Make yourself the moderator

1. Create your account in the game at https://play.aidaho.org.
2. On the server, run:

   ```bash
   sudo voidswarm-mod promote <your-username>
   ```

3. The dashboard is at **https://play.aidaho.org/admin**, and the in-game `/ban`, `/mute` and other commands now work for you. See [MODERATION.md](MODERATION.md).

## Day to day

| Task | Command (on the server) |
|---|---|
| Update to the latest code on GitHub | `sudo voidswarm-update` (backs up first, rebuilds, restarts) |
| Watch the server log | `journalctl -u voidswarm -f` |
| Restart | `sudo systemctl restart voidswarm` |
| Change settings (SMTP, filter, retention, off-box backup) | `sudo nano /etc/voidswarm/voidswarm.env`, then restart |
| Moderation CLI | `sudo voidswarm-mod bans` · `log --since 2h` · `reports --open` · `ban <name> 1d "reason"` |
| Manual backup | `sudo voidswarm-backup` |

## Backups

The nightly backups sit on the same disk as the live database, so if the server is lost, they go with it. Keep a copy somewhere else too, in either of these ways.

**Download a copy to your Windows PC** (every so often, and before big changes):

1. On the server, make a fresh backup and put a copy in your home folder. (The backups folder is readable only by the game's own user, so it has to be copied out with `sudo` first.)

   ```bash
   sudo voidswarm-backup
   sudo install -o "$USER" -m 600 /var/lib/voidswarm/backups/voidswarm-$(date +%F).db ~/
   ls ~/voidswarm-*.db
   ```

2. On your PC, in PowerShell, download it (use the file name `ls` printed, your server's IP, and `root@` instead of `ubuntu@` if that's your provider's user):

   ```powershell
   scp ubuntu@203.0.113.10:voidswarm-2026-09-28.db $HOME\Documents
   ```

   On AWS, add your key file right after `scp`: `scp -i $HOME\.ssh\LightsailDefaultKey-us-west-2.pem ubuntu@...`.

3. Back on the server, remove the copy: `rm ~/voidswarm-*.db`

Keep the downloaded file private: it holds every account (with hashed passwords) and their email addresses.

**Or copy every nightly backup off the server automatically.** Set `BACKUP_REMOTE` in `/etc/voidswarm/voidswarm.env` (new installs have example lines near the end of the file; on an older install, add the line yourself). Each night's backup is then also copied to:
- an S3 bucket (`BACKUP_REMOTE=s3://your-bucket/voidswarm/`), if the AWS command-line tool is installed and set up for root, or
- another machine over SSH (`BACKUP_REMOTE=backupuser@203.0.113.20:/srv/backups/voidswarm/`), if root on this server has an SSH key that machine accepts. The copy uses `scp`, so the other machine needs only SSH: an SFTP-only backup account or a Windows PC with OpenSSH works too.

Leave it unset and nothing is copied. The other side keeps every copy, so clear out old ones there. If a copy fails, the local backup is still made, and the problem shows in `journalctl -t voidswarm-backup`. The details are at the top of `/usr/local/bin/voidswarm-backup`.

## Sharing

- **Direct:** send **https://play.aidaho.org**. It's the full game, with accounts, from one address.
- **From GitHub Pages:** send `https://lawsonmode.github.io/voidswarm/?server=wss://play.aidaho.org`. Each time players open this link, the game first asks whether to connect to play.aidaho.org and warns that their login will be sent there; they click **Connect to play.aidaho.org**. (The direct link never asks.) The server already allows the Pages site to use its accounts API.
- **Keeping versions matched:** after you push code changes, run `sudo voidswarm-update` so the server matches the Pages site. If they differ, players see a "Protocol mismatch — please refresh" message.

## Other options

- **Home server:** a Raspberry Pi 5 plus a Cloudflare named tunnel costs about $80 once and then about $0.50/month in power. It needs aidaho.org's DNS moved to Cloudflare (free) for a permanent address; copy the website and MX records exactly. See [HOSTING.md](HOSTING.md).
- **Oracle Cloud Always Free:** the same `setup.sh` works on its free Ubuntu ARM machines. It really is free, but free capacity is often unavailable and idle free machines can be reclaimed.
