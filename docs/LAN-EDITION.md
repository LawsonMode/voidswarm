# Voidswarm LAN Edition: host guide (0.6, milestone 1)

The LAN Edition runs a whole Voidswarm server on one Windows PC, for a class or a household, with no internet and
nothing to install. It adds a **Host Control Panel**: a live view of the chat, the full chat log, custom words for the
filter, and announcements.

This guide covers what milestone 1 (M1) delivers. The design behind it is `docs/LAN-EDITION-proposal.md`.

| Milestone | What it adds | Status |
|---|---|---|
| **M1: host basics and the full chat log** | the portable package, first-run setup, the admin login, Home and the projector page, Live, the Chat log (reveal, context, export, retention), announcements, custom terms (add, remove, test), encrypted backups | **this guide** |
| M2: networking and HTTPS | the start page players open, HTTPS with a local certificate, the device check, the firewall helper | coming |
| M3: accounts | School accounts (school email with a code, or class rosters with login slips), account management | coming |
| M4: school features | Conduct, Rooms, Accounts and Settings tabs, custom-term import and confirm, release checks | coming |

Until M2, players connect to the game over plain `http://` on your network, and the panel tabs for M2 to M4 say
"arrives in a later update of 0.6".

---

## 1. Download, unblock, extract

1. **Download** `voidswarm-lan-<version>-win-x64.zip` (about 36 MB).
2. **Unblock it once, before extracting.** Right-click the zip → **Properties** → tick **Unblock** → **OK**. If you
   skip this, Windows warns about every file, and SmartScreen stops the launcher ("Windows protected your PC").
3. **Extract it into your user folder.** Right-click → **Extract All…**, type `%USERPROFILE%` in the box, and extract.
   You get `C:\Users\<you>\Voidswarm LAN`.

   | Don't extract to | Why |
   |---|---|
   | the Desktop or Documents | they often sync to OneDrive, which would copy the chat log and the keys to the cloud |
   | Downloads, Temp, a USB stick | antivirus suspicion, automatic clean-up, or no file permissions |
   | directly under `C:\` | every user of the PC could change the files |

   The launcher refuses those places and says where to move the folder.

The folder holds the official, signed `node.exe` (in `runtime\`), the game's code as readable text (`app\`, `web\`),
the double-click files, and `START HERE.html`. Everything the host creates goes into `data\`.

## 2. Start the host

Double-click **`Start Voidswarm Host.cmd`**.

- A small black window opens. **Keep it running**: closing it stops the game. Don't click inside it; a text selection
  pauses the window's output (the game keeps running).
- It prints the Host Control Panel's address (`http://localhost:7778`) and, the first time, a **setup code**.
- Your browser opens the panel with the setup code filled in.
- Starting it again while it runs just opens the panel again.

To stop the host, close the black window or press Ctrl+C in it. Chat is written to disk first; players see
"Server stopping — thanks for playing".

To try it on this PC alone, start it from a Command Prompt with `"Start Voidswarm Host.cmd" --this-pc-only`: the
game then stays on this PC (no other device can join, and Windows asks nothing about the network). `--no-browser`
skips opening the panel.

The ports are 7777 (the game) and 7778 (the panel). If either is busy, a Home host picks the next free pair once and
keeps it; a School host refuses and names the program holding the port.

## 3. First-run setup: the admin login

On the setup page:

1. The **setup code** is already there (it is also in the black window). It works for 30 minutes; after 5 wrong tries
   it stops working and the black window shows a new one.
2. Choose a **username** and a **password** of 10 characters or more for the host admin. Write the password down
   somewhere safe. This login is only for the panel; it is not a player account, and players can't take its name.
3. Choose **Home** or **School**, and name the server. School has stricter defaults (Presenting on at every sign-in,
   guests off, strict filter).

Until setup is done, the game listens on this PC only. Once it is done, the host restarts the game on your network
address, and the black window says where players join. The first time, Windows asks whether "Node.js JavaScript
Runtime" may use the network: choose **Allow** on **Private networks**.

Forgot the password? Stop the host and double-click **`Reset admin password.cmd`**. The next start shows a new setup
code, and players keep playing meanwhile.

## 4. The Host Control Panel

The panel is at **`http://localhost:7778`** and works only on the host PC in 0.6 M1. The game port has no admin
pages: `http://<this PC>:7777/admin` only says "The control panel is on the host PC".

The panel signs you out after 30 minutes without use. Private views (Reveal, exports, purges, custom terms, settings)
ask for your password again after 10 minutes.

### Home

- The join address, the rooms, how many pilots are online, and the alert counts. It shows no chat and no names, so it
  is safe on a projector.
- **Show on projector** opens `/display`: a page with just the join address, the rooms and your latest announcement,
  for a second screen.
- **Presenting** hides names, chat text and emails everywhere in the panel while you share your screen.

### Live

An auto-updating feed of the chat, with the time of each line, the room, and a coloured tag for each kind of language
the filter found (PROFANITY, VULGAR, HATE, THREAT, GANG, SELF-HARM, or your own custom categories).

Live shows **what the other players saw**. When a line was filtered, the others saw a friendly stand-in such as
"Great flying, everyone!" under the sender's name, and Live shows that line marked as substituted. The sender got a
private warning that never names the words: "That message used inappropriate language and wasn't shared. Keep chat
friendly!", then a second warning, then an automatic mute after the third.

A self-harm statement is never shown to anyone. The student gets a kind note with support information (988), and you
get an urgent **wellbeing alert** on Home that shows no name until you open it.

### Chat log

The full log of every chat line, kept for 90 days by default (change it on this tab; School records can also run to
a term's end date).

- Search by player, text, room, time, tag or action. Searches run in the background, so they never slow the game.
- **Reveal** shows what a student actually typed. Every reveal is recorded in the **Audit** tab.
- **Context** shows the lines around one line in the same room.
- **Export…** saves the log (or a filtered part) as CSV or JSON. The original text is included only if you tick it.
  CSV opens safely in Excel (formula-like cells are neutralised). Exports are audited.
- **Purge** deletes old lines now. It asks you to confirm the number of lines first, and a restored backup never
  brings purged lines back.

### Custom terms

Your own words for the filter, for local slang or a district's list. Type the word or phrase, a category (for
example `local`), and what happens:

- **Flag for review**: the line is shown as typed and marked for you to look at.
- **Replace with a friendly line**: the others see a stand-in, the sender gets the generic warning (a strike).
- **Block**: the same, for words that must never appear.

A term applies at once. **Try a line** shows what the filter would do with a sentence. The terms are never shown to
moderators and never written to the audit trail (only their category is). Importing a list and confirming imported
terms arrive in M4.

### Announcements

Type a message on Home to send `[Host] <message>` to every room, or to one. It shows on `/display` too.

### Audit

Every sign-in, reveal, export, purge, settings change, custom-term change and moderation action, newest first.

## 5. Where the data lives

Everything is in `Voidswarm LAN\data\`:

| What | Where |
|---|---|
| accounts, chat log, bans, reports, custom terms | `voidswarm.db` |
| settings | `voidswarm.config.json` |
| keys (the backup key, the pepper) | `secrets\` (only you, SYSTEM and Administrators can read it) |
| encrypted backups (at start, daily, before an upgrade) | `backups\` |
| exports saved on this PC (deleted after 7 days) | `exports\` |
| the host log (no chat text, no passwords) | `logs\` |

To go back to an earlier backup, stop the host and double-click **`Restore a backup.cmd`**.

To update, put the new zip in the folder and double-click **`Update Voidswarm.cmd`** while the host is stopped. The data,
the firewall permission and your shortcut stay; the old version is kept for rollback.

## 6. How it is built (for the curious)

- The black window is the **launcher** (`app\launch.mjs`): it checks the folder, holds a single-instance lock, and
  starts the **server** (`app\server.mjs`) as a separate process under Node's permission sandbox. The server can read
  only this folder, write only `data\`, and start no programs.
- Panel searches, exports, purges and backups run in a third process, the **maintenance process** (`app\maint.mjs`),
  with the same sandbox, so the game never waits on them.
- Nothing is sent to the internet. The fonts are bundled.

From source (developers): `npm run package:lan -- --out <folder outside dist/>` builds the zip; `npm run lan` runs the
launcher from source. See `README.md` and `ARCHITECTURE.md` §4c.
