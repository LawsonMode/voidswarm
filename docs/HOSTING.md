# Hosting Voidswarm

There are two ways to play:

| | Where | Who can play | Needs |
|---|---|---|---|
| **Offline vs bots** | GitHub Pages: https://lawsonmode.github.io/voidswarm/ | Anyone with a browser | Nothing. Deploys automatically on every push to `main` |
| **Online multiplayer** | Your PC, through a Cloudflare Tunnel | Anyone you send the link to, while your PC is hosting | `cloudflared` (free) |

GitHub Pages only serves static files. It can't run the Node game server (WebSockets + the accounts/loot database), so online play is hosted from your PC.

## Online multiplayer from your PC (Cloudflare quick tunnel)

One-time setup:

```powershell
winget install --id Cloudflare.cloudflared
```

Open a **new** terminal afterwards so `cloudflared` is on your PATH.

Each time you want to host:

```powershell
cd path\to\voidswarm      # your clone of the repo
powershell -ExecutionPolicy Bypass -File scripts\host-online.ps1
```

The script does four things:
1. Builds the game.
2. Opens a free `https://<random>.trycloudflare.com` tunnel.
3. Starts the server bound to `127.0.0.1` only, so the tunnel is the only way in.
4. Prints the link to share.

Friends open that link. The page, the game connection and accounts all come from the same address, so there's nothing to configure. Players already on the Pages site can instead enter `wss://<random>.trycloudflare.com` under **Server…**. Press **Ctrl+C** to stop hosting.

Notes:
- **Address:** a quick-tunnel address changes every time you run the script. For a permanent one, use a named tunnel (below).
- **Accounts:** accounts and loot live in `data/voidswarm.db` on your PC, which is gitignored. Back it up if it matters.
- **Password-reset email:** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` before running the script (see `src/server/auth/README.md`). Without SMTP, reset links are printed in the server window.
- **Security:** the server is never exposed directly. It listens on `127.0.0.1`, Cloudflare terminates HTTPS/WSS, and `TRUST_PROXY=1` lets per-player rate limits use the forwarded address.

## Antivirus (e.g. Bitdefender)

- **Quarantined cloudflared:** if the antivirus quarantines `cloudflared.exe` (tunnel tools sometimes get a "potentially unwanted" flag even though this one is signed by Cloudflare), restore it and add an exception for it.
- **Tunnel connection:** the tunnel connects **out** to Cloudflare. It tries QUIC (UDP 7844) first and falls back to HTTPS on TCP 443 if a firewall blocks UDP, so it normally needs no firewall rule.
- **Tunnel hosting:** the server listens on `127.0.0.1` only, so there is nothing for the firewall to prompt about.
- **LAN mode:** `npm start` does accept incoming connections. Allow `node.exe` on port 7777 for **private/home networks only**.
- **Script warnings:** if Advanced Threat Defense blocks `host-online.ps1`, check the alert first. The script only builds the game, starts `cloudflared`, and starts the Node server. Then add an exception for it rather than turning protection off.

## Named tunnel (permanent address, needs a domain on Cloudflare)

```powershell
cloudflared tunnel login                      # opens your browser; log in to Cloudflare yourself
cloudflared tunnel create voidswarm
cloudflared tunnel route dns voidswarm play.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:7777 voidswarm
```

In a second terminal:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\host-online.ps1 -TunnelUrl https://play.yourdomain.com
```

## LAN only (classroom / home)

```powershell
npm run build
npm start          # serves the game + server on port 7777
```

Players on the same network open `http://<your-PC-IP>:7777`. Plain HTTP is only acceptable on a LAN, so don't reuse real passwords there.
