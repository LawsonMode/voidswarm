# Host Voidswarm on your own PC

This runs the **whole game** from one computer: the game page, online multiplayer, accounts, loot, the chat log and the `/admin` moderation dashboard. Anyone on the **same network** (home Wi-Fi, a classroom or a LAN party) can join from a browser. It's free, and no coding is needed.

To play with people who are **not** on your network, see [Hosting over the internet](#hosting-over-the-internet) at the end.

## What you need

- A Windows 10/11 PC. A Mac or Linux computer works too, using a few typed commands.
- About 500 MB of free disk space.
- An internet connection for the first start, which downloads the game's packages.

## 1. Install Node.js (once)

Node.js is the free program that runs the game server.

1. Go to **[nodejs.org](https://nodejs.org/)** and download the **LTS** version (24 or newer).
2. Run the installer and keep all the default options. You don't need the optional "Tools for Native Modules".

## 2. Download the game

**Option A: ZIP (easiest)**
1. On the [Voidswarm GitHub page](https://github.com/LawsonMode/voidswarm), click the green **Code** button, then **Download ZIP**.
2. Right-click the downloaded ZIP and choose **Extract All**. Extract it to a folder that **doesn't sync to OneDrive**, such as `C:\Voidswarm` or your Downloads folder. A synced Documents folder can lock files while the game installs, and it keeps uploading the save file.

Always run the game from the **extracted** folder, not from inside the ZIP.

**Option B: git**

```bash
git clone https://github.com/LawsonMode/voidswarm.git
```

## 3. Start the server

**Windows:** open the game folder, open **`scripts`**, and double-click **`host-local.bat`**.

Extracting GitHub's ZIP often makes a folder inside a folder (`voidswarm-main\voidswarm-main`). If you don't see `scripts`, open the inner `voidswarm-main` folder first.

A window opens and works through four steps:
1. Checks Node.js.
2. Installs the game packages. This only happens the first time, or after an update, and takes a minute or two.
3. Builds the game.
4. Starts the server.

Keep that window open while you play. Closing it stops the game.

**Mac / Linux:** open a terminal in the game folder and run:

```bash
npm ci && npm run build && npm start
```

`npm ci` installs exactly the versions the game was tested with and never changes its files, so a later `git pull` stays clean.

## 4. Play, and invite friends

- **On this PC:** open **http://localhost:7777**.
- **Friends on the same Wi-Fi or network:** they open `http://<your-PC-IP>:7777`. The window prints the exact address as a line starting with **Friends on your network:**.
  - If it lists more than one address, use the one next to your Wi-Fi or Ethernet adapter.
  - On a Mac or Linux computer, find your IP in the network settings.
- **The first time,** Windows Firewall or your antivirus (Bitdefender, for example) may ask whether to allow **Node.js**. Allow it on **Private networks** only.

Everyone plays from their browser, and nobody else needs to install anything.

## 5. Make yourself the moderator

1. Open the game and **create your account**.
2. Open a terminal in the game folder. On Windows: click the folder's address bar in File Explorer, type `cmd` and press Enter.
3. Run:

   ```bash
   npm run mod -- promote NovaPilot
   ```

   Use your own game username instead of `NovaPilot`. Type it as it is, with no `< >` around it.

   A running server picks this up within a couple of seconds.
4. The moderator dashboard is at **http://localhost:7777/admin**. The in-game `/mute`, `/ban` and other commands now work for you. See [MODERATION.md](MODERATION.md).

## Stopping

Close the server window, or click it and press **Ctrl+C**. If it then asks `Terminate batch job (Y/N)?`, press **Y**.

## Updating to a new version

1. Stop the server.
2. Get the new version:
   - **ZIP:** download and extract the new ZIP. Then copy the **`data`** folder from your old game folder into the new one, so you keep your accounts and loot.
   - **git:** run `git pull` in the game folder.
3. Start it again with `host-local.bat`. It reinstalls packages and rebuilds automatically when needed.

Players who still have the old page open should **refresh** it.

## Your saves and backups

Accounts, loot and the chat log live in one file: **`data/voidswarm.db`** inside the game folder. It is never uploaded anywhere.

To back up, stop the server and copy the whole `data` folder somewhere safe.

## Troubleshooting

**"Node.js is not installed" or "'node' is not recognized"**
- Install the LTS version from [nodejs.org](https://nodejs.org/), then close the window and double-click `host-local.bat` again.
- If you just installed it and still see this, restart the PC.

**"Port 7777 is already in use"**
- The game is probably already running in another window. Close that window first.
- Or run it on another port from a terminal in the game folder: `scripts\host-local.bat -Port 7778`. Everyone then uses `:7778` instead of `:7777`.

**Friends can't connect**
- Check they're on the **same** network as your PC. A phone on mobile data won't work.
- Try the other addresses the window printed. Virtual adapters (for example "vEthernet" or "VirtualBox") won't work.
- **Firewall:** allow Node.js on **Private networks**. On Windows, also check that your network is set to Private: open **Settings → Network & internet → Wi-Fi → (your network)**, or **Ethernet** on a wired PC, and set **Network profile type** to **Private**. Only do this on a network you trust.
  - On a school-managed PC you may not be allowed to answer the firewall prompt. IT may need to allow Node.js on Private networks for you.
  - Bitdefender has its own firewall. Allow `node.exe` there for home/private networks only.
- **School or office Wi-Fi** often blocks devices from talking to each other. Ask IT, or use [internet hosting](#hosting-over-the-internet) instead.

**"Protocol mismatch ... Please refresh."**
- The page in the browser is older (or newer) than the server, usually right after an update.
- Refresh the page. If it keeps happening, clear the browser cache or restart the server.

**"Windows protected your PC" or the antivirus blocks the script**
- Files from a downloaded ZIP get flagged. Click **More info → Run anyway**, or right-click the ZIP → **Properties** → **Unblock** before extracting.
- If Bitdefender blocks `host-local.ps1`, read the alert first. The script only installs the game packages, builds the game and starts the Node.js server, so it's fine to add an exception for it rather than turning protection off.

**The install or build fails**
- Check the PC is online and run `host-local.bat` again.
- If it keeps failing, delete the `node_modules` folder in the game folder and try once more.

**Passwords**
- Local hosting uses plain `http`, not encrypted `https`, so anyone on the network could in principle read the traffic.
- Tell players **not to reuse a real password** (school, email, etc.) for their game account.

**Password-reset emails**
- Without email settings, a reset link is printed in the server window instead of emailed, like `http://localhost:7777/?reset=...`.
- Before you pass it on, replace `localhost` with this PC's address from the **Friends on your network** line, for example `http://192.168.1.20:7777/?reset=...`. A `localhost` link would open the player's own device, not your server.
- To send real emails, see [src/server/auth/README.md](../src/server/auth/README.md).

## Hosting over the internet

- **From this PC, with a free link to share:** [HOSTING.md](HOSTING.md) uses a Cloudflare tunnel and `scripts\host-online.ps1`. It works while your PC is on.
- **Always on, on your own domain:** [DEPLOY-VPS.md](DEPLOY-VPS.md) covers a small cloud server, about $7–12/month; [DEPLOY-AWS.md](DEPLOY-AWS.md) walks through AWS Lightsail step by step.
