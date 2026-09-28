# Always-on server on a VPS (e.g. play.aidaho.org)

This runs the whole game on a small cloud server, around the clock, whether your PC is on or not: the game page, multiplayer, accounts, loot, the chat log and `/admin`. Your existing website and email are untouched; you only add one DNS record.

**Cost:** about $4–6/month. A 1–2 vCPU / 1–4 GB plan is plenty for a full 32-player lobby.

## 1. Create the server (about 5 minutes)

Pick a provider. Hetzner Cloud is the cheapest; DigitalOcean and Lightsail are also fine.

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

From your PC, connect with `ssh root@<server-ip>`, then:

```bash
curl -fsSL https://raw.githubusercontent.com/LawsonMode/voidswarm/main/deploy/vps/setup.sh -o setup.sh
sudo DOMAIN=play.aidaho.org EMAIL=you@example.com bash setup.sh
```

`EMAIL` is only used by Let's Encrypt for certificate-expiry notices. When the script finishes, open **https://play.aidaho.org**. The HTTPS certificate is issued automatically on the first visit.

What `setup.sh` sets up:
- **Software:** Node 24, Caddy (automatic HTTPS and WebSockets) and sqlite3.
- **Firewall:** only SSH, 80 and 443 are open.
- **The game:** cloned to `/opt/voidswarm`, built, and run as the restricted `voidswarm` user. It listens on `127.0.0.1` only, behind Caddy, with `systemd` restarting it if it stops.
- **Data:** accounts, loot and chat log live in `/var/lib/voidswarm/voidswarm.db`, backed up nightly to `/var/lib/voidswarm/backups/` with 14 days kept.
- **Settings:** in `/etc/voidswarm/voidswarm.env`, covering the chat-filter strictness, log retention and optional SMTP for password-reset email.

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
| Change settings (SMTP, filter, retention) | `sudo nano /etc/voidswarm/voidswarm.env`, then restart |
| Moderation CLI | `sudo voidswarm-mod bans` · `log --since 2h` · `reports --open` · `ban <name> 1d "reason"` |
| Manual backup | `sudo voidswarm-backup` |

## Sharing

- **Direct:** send **https://play.aidaho.org**. It's the full game, with accounts, from one address.
- **From GitHub Pages:** send `https://lawsonmode.github.io/voidswarm/?server=wss://play.aidaho.org`. Players confirm the server once. The server already allows the Pages site to use its accounts API.
- **Keeping versions matched:** after you push code changes, run `sudo voidswarm-update` so the server matches the Pages site. If they differ, players see a "Protocol mismatch — please refresh" message.

## Other options

- **Home server:** a Raspberry Pi 5 plus a Cloudflare named tunnel costs about $80 once and then about $0.50/month in power. It needs aidaho.org's DNS moved to Cloudflare (free) for a permanent address; copy the website and MX records exactly. See [HOSTING.md](HOSTING.md).
- **Oracle Cloud Always Free:** the same `setup.sh` works on its free Ubuntu ARM machines. It really is free, but free capacity is often unavailable and idle free machines can be reclaimed.
