# Always-on server on Amazon Lightsail (AWS)

This guide puts the whole game on an Amazon Lightsail server at **play.aidaho.org**, running around the clock whether your PC is on or not. It uses the same one-command installer as [DEPLOY-VPS.md](DEPLOY-VPS.md). This page adds the AWS-only steps around it: the account plan, a static IP, the Lightsail firewall and snapshots.

**What you'll use:**
- **Service:** Amazon Lightsail, not EC2. Lightsail has a flat monthly price with a large traffic allowance included, so the bill doesn't grow as more people play.
- **Region:** Oregon (`us-west-2`), the closest to Idaho.
- **Operating system:** Ubuntu 24.04 LTS.
- **Plan:** the **$12/month** dual-stack plan: 2 GB RAM, 2 vCPUs, 60 GB SSD and 3 TB of transfer a month.
- **Cost:** about $12.50/month once the free credits run out. See [What it costs](#what-it-costs).

**Before you start, have:**
- an AWS account
- your Network Solutions login (for the one DNS record)
- about an hour

The plan prices, transfer allowances and credit amounts were checked on aws.amazon.com/lightsail/pricing and aws.amazon.com/free on 2026-09-28. Figures marked "about" or "~" are estimates. AWS can change any of them. Menu and button names are as of this writing and may differ slightly in the current console.

---

## 1. Account first: the Paid plan and a budget alert

Do this before creating anything.

1. **Check your account plan.** In the AWS console, open **Billing and Cost Management** and find **Account plan**. It says **Free** or **Paid**.
   - On the **Free** plan you are never charged. But the account closes after 6 months or when the credits run out, whichever comes first, and **your server goes with it**.
   - **Upgrade to Paid before you rely on the server.** Any credits you have left carry over.
2. **Set up a budget alert.** Go to **Billing and Cost Management → Budgets → Create budget**. Choose a **monthly cost budget**, set it to about **$15**, and enter your email for the alert. Budgets are free.
3. **Know your credits.** New accounts get $100 in credits at sign-up, plus up to $100 more for completing starter activities.
   - Per AWS's credit terms, setting up a budget is one of those activities, the credits can be used on Lightsail, and they expire 12 months after sign-up. Check the **Credits** page in the Billing console for your own dates and amounts.
   - On the Paid plan, the credits pay the bill first.

## 2. Pick the region: Oregon

Everything in this guide goes in **Oregon (us-west-2)**: the server, the static IP and the snapshots.
- Oregon gets the full transfer allowance.
- Keeping everything in one region makes it hard to forget something that's still billing.

## 3. Create the server

1. Open the Lightsail console: https://lightsail.aws.amazon.com
2. Click **Create instance**.
3. **Instance location:** make sure it says **Oregon (us-west-2)**. If not, click **Change AWS Region and Availability Zone** and pick Oregon. Any zone is fine.
4. **Platform:** Linux/Unix.
5. **Blueprint:** **OS Only → Ubuntu 24.04 LTS**.
6. **SSH key pair:** leave the default key. You'll download it in step 4.
7. **Plan:**
   - Pick **Dual-stack**, **not "IPv6-only"**. An IPv6-only server can't download the game from GitHub, and players on IPv4-only networks couldn't reach it. It saves $2 a month, but the game can't run on it.
   - Pick the **$12** plan (2 GB RAM, 2 vCPUs, 60 GB SSD, 3 TB transfer).
8. **Name:** `voidswarm`.
9. Click **Create instance**. Wait until it shows **Running** (a minute or two).

**Other plan sizes:**
- **$7** (1 GB RAM, 2 TB transfer): fine for casual play. The installer adds a swap file automatically on plans this small.
- **$42 compute-optimized** (2 dedicated vCPUs, 4 GB RAM, 5 TB transfer): for a nightly full 32-player match. Its CPU is never slowed down.
- **Moving up later is easy:**
  1. Take a snapshot and create the bigger instance from it.
  2. On the new instance, check the firewall has the HTTPS rule (step 6) and turn on automatic snapshots (step 7). Those settings belong to each instance, so a new one may not have them.
  3. Move the static IP: detach it from the old instance and attach it to the new one (Networking tab). The DNS record doesn't change.
  4. Delete the old instance. It keeps billing until you do.

## 4. SSH key, or the browser

You can reach the server two ways. Pick one (or both).

- **In the browser (nothing to install):** open the instance, go to the **Connect** tab and click **Connect using SSH**. A terminal opens in a new window.
- **From your PC's PowerShell:**
  1. In Lightsail, click **Account** (top right) → **Account** → **SSH keys**.
  2. Next to Oregon's **default key**, click **Download**. The file is named like `LightsailDefaultKey-us-west-2.pem`.
  3. Move it into your `.ssh` folder:

     ```powershell
     New-Item -ItemType Directory -Force $HOME\.ssh
     Move-Item $HOME\Downloads\LightsailDefaultKey-us-west-2.pem $HOME\.ssh\
     ```

  Keep this file private. Anyone who has it can log in to your server.

## 5. Attach a static IP (before the DNS step)

The server's default public IP changes whenever it's stopped and started. A static IP never changes, so that's the one the DNS record points to.

1. On the Lightsail home page, open the **Networking** tab.
2. Click **Create static IP**.
3. Location: **Oregon**. **Attach to an instance:** `voidswarm`.
4. Name it (for example `voidswarm-ip`) and click **Create**.
5. Write down the address. This guide uses `203.0.113.10` as an example; yours will differ.

A static IP is **free while it's attached** to an instance. Left unattached, it costs about $0.005 an hour (about $3.60 a month), so release it if you ever delete the server.

## 6. Open the firewall: add HTTPS (443)

Lightsail has its own firewall in front of the server. By default it opens only SSH (22) and HTTP (80). The game needs HTTPS (443) too.

1. Open the `voidswarm` instance and go to the **Networking** tab.
2. Under **IPv4 Firewall**, click **Add rule**, choose **HTTPS**, and click **Create**. You should now have SSH 22, HTTP 80 and HTTPS 443.
3. Scroll down to the **IPv6 Firewall** and do the same: add **HTTPS**. (Or delete the IPv6 rules instead. The game works over IPv4 either way.)
4. **Never add port 7777.** The game listens only inside the server (`127.0.0.1`), behind Caddy, which handles HTTPS on 443. Opening 7777 wouldn't help, and keeping it closed is a second lock in case a setting is ever changed by mistake.

If `https://play.aidaho.org` ever times out, a missing 443 rule is almost always why.

## 7. Turn on automatic snapshots

A snapshot is a copy of the whole server that you can rebuild from.

1. On the instance, open the **Snapshots** tab.
2. Turn on **Automatic snapshots**. Lightsail keeps the 7 most recent.
3. Set the snapshot time to about an hour after the nightly database backup, so each snapshot holds that night's clean copy:
   - **11:00 UTC** if you'll use `TZ=America/Boise` in step 10 (the backup then runs at 3:17 am Idaho time)
   - **04:00 UTC** if you leave the server on UTC

Snapshots cost $0.05 per GB-month of used space, which is roughly $0.50 a month here (an estimate).

## 8. Point play.aidaho.org at the static IP (Network Solutions)

1. Log in to Network Solutions and go to **Domains → aidaho.org → Manage DNS / Advanced DNS Records**.
2. **Add an A record:**
   - Host: `play`
   - Points to: your **static IP** from step 5
   - TTL: the lowest offered
3. **Leave every other record alone**, especially `@` and `www` (your website) and the MX records (your email).
4. **Don't add an AAAA (IPv6) record.** Only the A record is needed.
5. On your PC, wait until this shows the static IP (usually minutes, sometimes an hour or two):

   ```powershell
   Resolve-DnsName play.aidaho.org
   ```

## 9. Connect to the server

- **Browser:** instance → **Connect** tab → **Connect using SSH**.
- **PowerShell:**

  ```powershell
  ssh -i $HOME\.ssh\LightsailDefaultKey-us-west-2.pem ubuntu@203.0.113.10
  ```

  - The user name on AWS is **`ubuntu`**, not `root`.
  - The first time, it asks whether to trust the server. Type `yes`.
  - **If it says the key file is "UNPROTECTED" or has bad permissions,** Windows is letting other accounts read it. Fix that once, then connect again:

    ```powershell
    icacls $HOME\.ssh\LightsailDefaultKey-us-west-2.pem /inheritance:r /grant:r "$($env:USERNAME):(R)"
    ```

  - If it prints **Please login as the user "ubuntu" rather than the user "root"** and disconnects, you typed `root@`. Use `ubuntu@`.
  - "Permission denied (publickey)" usually means the wrong key file, or a key from another region (each region has its own default key).

## 10. Install the game

On the server, run:

```bash
curl -fsSL https://raw.githubusercontent.com/LawsonMode/voidswarm/main/deploy/vps/setup.sh -o setup.sh
sudo DOMAIN=play.aidaho.org EMAIL=you@example.com TZ=America/Boise bash setup.sh
```

- **`EMAIL`** (optional): your own address, as the contact on the HTTPS certificate account. Caddy renews the certificate by itself, so there's nothing to watch for (Let's Encrypt stopped sending expiry emails in 2025).
- **`TZ`:** sets the server's time zone, so the nightly backup runs at 3:17 am Idaho time. AWS servers start on UTC, which would put it at about 9:17 pm, in the middle of evening play. Leave `TZ=...` out to keep UTC.

**Checks first.** Before installing anything, the script checks four things and stops with a plain explanation if one fails. Nothing has been changed at that point, so fix the problem and run the same command again.
- **The server can reach GitHub over IPv4.** If this fails, the instance is probably IPv6-only: create a dual-stack one (step 3).
- **`play.aidaho.org` points at this server.** If it doesn't, Let's Encrypt couldn't issue the certificate, and after a few failed tries it refuses the name for a while. Usually the DNS record just hasn't shown up yet: wait, then re-run. To see what the internet sees, run `dig +short play.aidaho.org @1.1.1.1` on the server. (If you're sure the DNS is right, add `SKIP_DNS_CHECK=1` after `sudo`.)
- **No IPv6 (AAAA) record points somewhere else.** If one does, delete it at Network Solutions (step 8). Only the A record is needed.
- **The `TZ` name is real.** Capitals matter: `America/Boise`.

Then it installs everything. That takes about 5 minutes. On the $7 plan it also adds a 2 GB swap file so the build can't run out of memory. It prints a reminder about the cloud firewall (step 6) before it starts installing and again at the end.

It's safe to run again later. It skips what's already done and keeps your settings file.

## 11. Check that it works

1. Open **https://play.aidaho.org**. Caddy gets the HTTPS certificate within about a minute of the install finishing. If the page doesn't load yet, wait a minute and refresh.
2. On the server, check that the game's own port is private:

   ```bash
   sudo ss -ltnp | grep 7777
   ```

   It should show `127.0.0.1:7777` only, never `0.0.0.0:7777` or `*:7777`.
3. To watch the server log: `journalctl -u voidswarm -f` (press Ctrl+C to stop watching).
4. Optional, from your PC: `Test-NetConnection play.aidaho.org -Port 7777` should report `TcpTestSucceeded : False`.

## 12. Make yourself the moderator

1. Create your account in the game at https://play.aidaho.org, for example `NovaPilot`.
2. On the server:

   ```bash
   sudo voidswarm-mod promote NovaPilot
   ```

3. The dashboard is at **https://play.aidaho.org/admin**, and the in-game moderator commands now work for you. See [MODERATION.md](MODERATION.md).

## 13. Share it

- **Direct:** send **https://play.aidaho.org**. It's the full game, with accounts, from one address.
- **From GitHub Pages:** send `https://lawsonmode.github.io/voidswarm/?server=wss://play.aidaho.org`.
  - Each time players open this link, the game first asks whether to connect to play.aidaho.org and warns that their login will be sent there. That's expected: they click **Connect to play.aidaho.org**. (The direct link above never asks.)
  - Nothing needs changing on the server: it already lets the Pages site use its accounts.

## 14. Password-reset email (optional)

AWS blocks outgoing mail on port 25. The game sends on port **587**, which works. Pick one:

- **Nothing.** Reset links are printed in the server log (`journalctl -u voidswarm`), and you can pass them on by hand.
- **A mailbox you already have**, such as an aidaho.org address at Network Solutions. Use its SMTP server on port 587 (your mail host's help pages give the server name). aidaho.org's SPF record already covers mail sent this way.
- **Amazon SES** (AWS's email service):
  1. In the SES console, in **Oregon**, verify the domain `aidaho.org`. SES gives you **3 DKIM records**; add them at Network Solutions.
  2. **Request production access.** Until then, SES only sends to addresses you've verified yourself.
  3. Create **SMTP credentials** in SES. These are separate from your AWS login.
  4. Use `SMTP_HOST=email-smtp.us-west-2.amazonaws.com` and `SMTP_PORT=587`.

To turn one on:
1. Edit the settings file: `sudo nano /etc/voidswarm/voidswarm.env`. It has a commented-out example for a mailbox and one for SES.
2. Remove the `#` in front of one example's lines and fill in your details. **Put double quotes around any value that contains spaces**, for example `MAIL_FROM="Voidswarm <noreply@aidaho.org>"`.
3. Save (Ctrl+O, Enter) and exit (Ctrl+X).
4. Restart: `sudo systemctl restart voidswarm`.
5. Check the log (`journalctl -u voidswarm -n 30`) for `[auth] SMTP mail enabled via ...`.

The password lives only in that file on the server. Don't paste it into chat, email or the repo.

## 15. Updating

After you push changes to `main` on GitHub, update the server **right away**:

```bash
sudo voidswarm-update
```

It backs up the database first, then downloads, rebuilds and restarts.

Why right away: GitHub Pages updates itself on every push, but the server only updates when you run this. When the network protocol version changes (version 0.5.0 moved it from 4 to 5), the two can't talk to each other, and Pages players see a "Protocol mismatch" message until the server catches up.

## 16. Backups

- **Nightly:** the server backs up its database at 3:17 am (14 days kept), and before every update.
- **Snapshots** (step 7) copy the whole server.
- **Off the server:** the nightly backups sit on the server's own disk, and snapshots stay in the same AWS account. Now and then, also download a copy of the database to your PC. The steps are in [DEPLOY-VPS.md → Backups](DEPLOY-VPS.md#backups). On AWS, the download command needs your key file:

  ```powershell
  scp -i $HOME\.ssh\LightsailDefaultKey-us-west-2.pem ubuntu@203.0.113.10:voidswarm-2026-09-28.db $HOME\Documents
  ```

- **Automatic off-box copies** (optional): set `BACKUP_REMOTE` in the settings file, for example to an S3 bucket. This needs the AWS command-line tool on the server (`sudo snap install aws-cli --classic`, then `sudo aws configure` with an access key that may write to that bucket). S3 storage is billed separately. See [DEPLOY-VPS.md → Backups](DEPLOY-VPS.md#backups).

## What it costs

**Measured traffic.** These numbers come from running the real server with bots. They're planning numbers: real players may use somewhat less.
- Each player downloads ~0.14–0.49 GB per hour of play, from an 8-ship Arena up to a full 32-ship Warzone.
- Each player uploads about 0.08 GB per hour.
- A full 32-player Warzone sends out about 35 Mbit/s.

**Three example months:**

| Scenario | Player-hours a month | Traffic (in + out) |
|---|---|---|
| **A. Casual:** 6 players, 2 h a night, 4 nights a week | 208 | ~85 GB |
| **B. Active:** about 12 players on average, 4 h a day | 1,461 | ~595 GB |
| **C. Busy:** a full 32-player match, 6 h a day | 5,844 | ~3,370 GB |

**Monthly cost in Oregon once the credits are used up:**

| Plan | A. Casual | B. Active | C. Busy |
|---|---|---|---|
| $7 (1 GB RAM, 2 TB transfer) | ~$7.50 | ~$7.50 | ~$115–130 (over the allowance, and too small) |
| **$12 (2 GB RAM, 3 TB transfer), recommended** | **~$12.50** | **~$12.50** | ~$41–46 (over the allowance; CPU borderline) |
| $42 compute-optimized (4 GB RAM, 5 TB transfer) | ~$42.50 | ~$42.50 | **~$42.50** |

**How that adds up:**
- **The plan price includes** the disk, the public IPv4 address and the transfer allowance.
- **Static IP:** $0 while attached.
- **Snapshots:** about $0.50 (an estimate).
- **Overage:** Lightsail counts traffic in **both** directions toward the allowance. Past it, extra outbound traffic costs $0.09/GB. Only scenario C goes over. The C figures are ranges because only the outbound share is charged.
- **CPU:** in scenario C, watch the **Metrics** tab. The CPU graph has a "sustainable" zone and a "burstable" zone. If busy nights keep landing in the burstable zone, move up to the $42 plan.
- **A middle option for scenario C:** if you're regularly that busy but the CPU graph stays in the sustainable zone, the **$24** plan (4 GB RAM, 4 TB transfer) avoids the overage for about $24.50 a month. Move to $42 only if the CPU keeps bursting.

**Your free credits:** $100 at sign-up, plus up to $100 more from starter activities. On the Paid plan they pay the bill first:
- **$12 plan:** $100 covers about 8 months, longer with the activity credits.
- **$7 plan:** 12 × $7.50 = $90, so the sign-up credits could cover the whole first year.
- Per AWS's credit terms, credits expire 12 months after sign-up, whatever is left. Check the Billing console for your dates.

**Why not EC2:** EC2 charges separately for the public IPv4 address and the disk, and includes only 100 GB of outbound traffic a month before charging $0.09/GB. By the same estimates, an EC2 t4g.small comes to about $18 / $51 / $270 a month (scenarios A / B / C) once AWS's T4g free trial ends on Dec 31, 2026. Until then the trial takes about $12 off on the Paid plan, but the traffic charges are what make B and C expensive either way.

## Avoiding surprise charges

- **Set up the budget alert first** (step 1). It's free.
- **Keep everything in Oregon.** Things made in another region are easy to forget, and some regions get only half the transfer allowance.
- **Stopping the instance doesn't stop the charge.** A stopped Lightsail instance is still billed. Only deleting it stops the bill.
- **When you take the server down for good:**
  1. Download a last copy of the database ([DEPLOY-VPS.md → Backups](DEPLOY-VPS.md#backups)).
  2. Delete the instance.
  3. **Release the static IP** (Networking tab). Unattached, it costs about $3.60 a month.
  4. **Delete any snapshots** you no longer need (the Snapshots tab). They cost $0.05 per GB-month until you do.
  5. Remove the `play` A record at Network Solutions.
- **Don't pick an IPv6-only plan** to save $2 (see step 3).
- **Put a calendar reminder** a little before your credits expire.
- If you try other starter activities for credits (EC2, Lambda and so on), **delete whatever they create** right afterwards.

## What you don't need

- **A load balancer** ($18/month) or AWS certificates. Caddy on the server gets free HTTPS from Let's Encrypt.
- **RDS or any managed database.** Accounts, loot and the chat log are SQLite files on the server's own disk.
- **Route 53 or a new domain.** One A record at Network Solutions is all it takes.
- **CloudFront or S3 for the game page.** Caddy serves it from the server, and GitHub Pages serves it too.
- **Extra block storage.** The plan's 60 GB SSD is plenty.
- **Reserved Instances, Savings Plans, containers or auto-scaling.** Each is far more than one small server needs.
- **SES**, unless you want password-reset emails sent through it (step 14).

## Troubleshooting

| What you see | Usual reason | Fix |
|---|---|---|
| `https://play.aidaho.org` times out | Port 443 isn't open in the Lightsail firewall | Step 6, on both the IPv4 and IPv6 tabs |
| setup.sh stops: "doesn't point at this server yet" | The A record isn't there yet, or points somewhere else | Step 8; wait until `dig +short play.aidaho.org @1.1.1.1` shows the static IP, then run again |
| setup.sh stops: "That's a private address" | The A record uses the instance's private IP | Change it to the static IP (step 5) |
| setup.sh stops: "also has an IPv6 (AAAA) record" | An AAAA record exists for `play` | Delete it at Network Solutions (step 8) |
| setup.sh stops: "can't reach github.com over IPv4" | The instance is IPv6-only | Create a dual-stack instance (step 3) |
| ssh: "UNPROTECTED PRIVATE KEY FILE" | Windows lets other accounts read the key | The `icacls` command in step 9 |
| ssh: "Please login as the user ubuntu rather than the user root" | Used `root@` | Use `ubuntu@` |
| ssh: "Permission denied (publickey)" | The wrong key file, or a key from another region | Use the Oregon default key (step 4) |
| Pages players see "Protocol mismatch" | The server is behind GitHub | `sudo voidswarm-update` |
| Lag on busy nights | The CPU ran out of burst | Check the Metrics tab; move up a plan (step 3) |
