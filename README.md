# Ember's Adrift — Loot Ledger

A hosted loot tracker: rune wishlists with fair rolling cycles, guild rune/material
stock, and relic/artifact drop history — with simple approval-based access so you
control who can view or edit it.

## How it's built

- **Server**: a small dependency-free Node server (`server.js`) that serves the app
  and exposes a JSON API.
- **Storage**: the actual data (players, wishlists, history, etc.) lives in a JSON
  file *inside a GitHub repo*, read and written by the server using a token that
  never leaves the server. This is what makes the data durable on free hosting —
  most free Node hosts (including Render's free tier) wipe local files on every
  restart, but a file in a git repo survives that just fine.
- **Access**: anyone can request access by typing their name. You approve or deny
  requests from a password-protected admin screen. Approving someone generates a
  one-time link — send it to them, they open it once, and they're in from then on
  (the link stores a token in their browser; no password for them to manage).

## One-time setup

You have two options for storage. **If you're on a paid Render plan, use Option A**
— it's simpler and has no external dependency. Option B (GitHub-backed storage) is
what you'd use on Render's *free* tier instead, since free services can't attach a
persistent disk.

### Option A: Persistent disk (paid Render plans)

1. Push this project to a GitHub repo. Render deploys from it.
2. On [render.com](https://render.com): **New → Web Service**, connect that repo.
3. Environment: **Node**. Build command: blank (nothing to install). Start command: `node server.js`.
4. Pick a **paid** instance type (persistent disks aren't available on Free).
5. Under **Advanced**, click **Add Disk**. Give it a mount path, e.g. `/data`.
6. Under **Environment Variables**, add:
   - `DATA_DIR` — the same mount path you chose, e.g. `/data`
   - `ADMIN_PASSWORD` — a password only you know, used to open the admin screen
7. Click **Create Web Service**. You'll get a public URL like `https://your-app.onrender.com`.

That's it — the app writes `data.json` straight onto that disk, and it survives
restarts and redeploys, since that's exactly what a persistent disk is for.

### Option B: GitHub-backed storage (free Render plans)

#### 1. Create a data repo on GitHub

Make a small **private** repo to hold the ledger's data file — it can be empty,
it doesn't need to be this repo. Note the `owner/repo` name (e.g. `yourname/ember-loot-data`).

#### 2. Create a fine-grained personal access token

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.

- **Repository access**: "Only select repositories" → pick the data repo from step 1.
- **Permissions**: under "Repository permissions," set **Contents** to **Read and write**. Leave everything else at "No access."
- Copy the token — you'll paste it into Render as `GITHUB_TOKEN` in a minute.

Scoping it to just this one repo means even in the worst case (a bug, a leak) the
blast radius is one small data repo, not your whole GitHub account.

#### 3. Push this project to a GitHub repo

This is the *code* repo (can be the same one as your data repo, or a separate
public/private repo — doesn't matter, they're unrelated to each other from Render's
point of view). Render deploys from this repo.

#### 4. Deploy to Render

1. Go to [render.com](https://render.com), sign up (free), and click **New → Web Service**.
2. Connect the GitHub repo you pushed in step 3.
3. Environment: **Node**. Build command: (leave blank / `npm install` is fine, there's nothing to install). Start command: `node server.js`.
4. Instance type: **Free**.
5. Under **Environment Variables**, add:
   - `GITHUB_TOKEN` — the token from step 2
   - `GITHUB_REPO` — `owner/repo` of your data repo from step 1
   - `ADMIN_PASSWORD` — a password only you know, used to open the admin screen
   - *(optional)* `GITHUB_DATA_PATH` — defaults to `ledger-data.json` if you don't set it
   - *(optional)* `GITHUB_BRANCH` — defaults to `main`
6. Click **Create Web Service**. Render builds it and gives you a public URL like `https://your-app.onrender.com`.

That's it — that URL is what you share with your guild.

## Approving people

1. Go to `https://your-app.onrender.com/?admin=1`.
2. Enter your admin password, click **Load requests**.
3. When someone requests access (they'll do this automatically the first time they
   visit the main URL), you'll see their name under **Pending requests**. Click
   **Approve**.
4. You'll get back a personal link like `https://your-app.onrender.com/?token=abc123...`.
   Send that to them (Discord, in-game chat, whatever). They click it once and
   they're in — the app remembers them after that.
5. Made a mistake, or someone shouldn't have access anymore? Find them under
   **Approved users** and click **Revoke**.

## Notes and caveats

- **Free tier cold starts** (Option B only): Render's free web services spin down
  after 15 minutes of no traffic, and take 30–60 seconds to wake back up on the
  next visit. Paid instances (Option A) don't do this.
- **This isn't bulletproof security.** The admin password gates the admin screen,
  and approved tokens gate the data — that's enough to keep out randoms, but
  it's not built to withstand a determined attacker. Don't put anything truly
  sensitive in here.
- **Concurrent edits**: with Option A (persistent disk), writes just overwrite the
  file directly — two saves at the exact same instant could clobber each other,
  same as any simple file-backed app. With Option B (GitHub), every save re-reads
  the file right before writing, which shrinks that window further. Either way,
  for a guild's loot tracker this is a non-issue in practice.
- With Option B, every save shows up as a commit in your data repo — which
  doubles as a free, complete history of every change ever made, if you're curious.
  Option A doesn't get you this for free, though you could add your own backup
  routine if you wanted it.

## Running it locally instead

You can still run this without any of the above, purely on your own machine:

```
node server.js
```

Then open `http://localhost:3939`. Without `GITHUB_TOKEN`/`GITHUB_REPO` set, it
falls back to a local `data.json` file next to `server.js` — fine for local use,
just remember that's the mode where "wipes on restart" doesn't apply, since it's
never restarting on you.

Note that without `ADMIN_PASSWORD` set, the admin screen will refuse every
request — set it (even locally) if you want to test the approval flow.
