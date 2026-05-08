# Deployment Guide — SETT Group Booking API

This document describes the **only** supported way to deploy and run the SETT Group Booking API in production. Following it prevents the class of incident we hit on 2026-05-07 where two PM2 daemons (one as `root`, one as `groupai`) raced for the same port and the server kept serving stale code.

## TL;DR — the rules

1. **Deploy as the `groupai` user only.** Never run `pm2`, `node`, or `npm` for this service as `root`.
2. **One PM2 daemon per host.** The official daemon is `pm2-groupai.service` (systemd-managed, reboot-safe). Do not start a second one.
3. **One process manager.** PM2 is the only thing that should run `dist/server.js`. No raw `node dist/server.js`, no `screen`, no `nohup`.
4. **Build before restart, every time.** A `git pull` does not rebuild the JavaScript. PM2 reads `dist/`, so an unbuilt deploy serves the old code.

---

## Production environment

| Item | Value |
|---|---|
| Host | `ubuntu-8gb-nbg1-1` (Hetzner, Nuremberg) |
| OS | Ubuntu 24.04 |
| Public hostname | `group-ai.s-e-t-t.com` |
| Public port | 443 (nginx → Next.js frontend on `:3003` → API on `:3005`) |
| API port | `3005` (set in `.env` as `PORT=3005`) |
| Deploy user | `groupai` |
| App home | `/home/groupai/sett_be` |
| Process manager | PM2 (under `groupai`, systemd-supervised via `pm2-groupai.service`) |
| Database | PostgreSQL 16, local socket, user `groupai`, db `groupai_db` |

---

## Standard deploy procedure

Run every step as the `groupai` user (`sudo -u groupai bash -lc '…'` if you SSH in as someone else):

```bash
# 1. SSH in as groupai (or sudo to it)
ssh groupai@ubuntu-8gb-nbg1-1
cd ~/sett_be

# 2. Pull the latest code from the deployment branch
git fetch --all
git checkout milestone_4v7        # or whatever branch is current
git pull --ff-only

# 3. Install dependencies (only if package.json changed)
npm ci

# 4. Apply DB migrations if any are new
npx prisma migrate deploy

# 5. Regenerate Prisma client if schema.prisma changed
npx prisma generate

# 6. Build TypeScript → dist/
npm run build

# 7. Restart the API cluster
pm2 restart sett-ai-server

# 8. Verify health
curl -sS http://localhost:3005/health
# → {"status":"OK","timestamp":"…"}

# 9. Persist the PM2 process list (so it survives reboots)
pm2 save
```

A typical deploy is steps 2 → 6 → 7 → 8 (no migrations, no schema change, no new packages). 30 seconds of downtime at most.

---

## Verifying the cluster after deploy

```bash
# Confirm only ONE node process is running dist/server.js, owned by groupai
ps -ef | grep '/dist/server.js' | grep -v grep

# Confirm port 3005 is held by groupai's PM2 daemon
ss -tlnp 2>/dev/null | grep ':3005' | head -3

# Confirm there is no root-owned PM2 daemon
ps -ef | grep 'PM2 v.* God Daemon' | grep -v grep
# Expect to see only groupai (489573-ish), claude (separate ticket-api), and aitool (frontend).
# If you see one owned by root, something has gone wrong — see "Recovering from a competing daemon" below.

# Confirm the resolver tests still pass against the live DB
npx jest src/tests/destinationResolver.test.ts --runInBand --forceExit
# → 12 passed in ~6 seconds
```

---

## Reboot safety

`pm2-groupai.service` is registered with systemd and enabled. On boot:

```
systemd → pm2-groupai.service → pm2 resurrect → reads /home/groupai/.pm2/dump.pm2 → starts sett-ai-server
```

`dump.pm2` is updated whenever you run `pm2 save`. **Always run `pm2 save` after a `pm2 restart` or `pm2 start`** so the next reboot brings up the same processes you have running now.

If something is missing after a reboot, check:

```bash
sudo systemctl status pm2-groupai.service
sudo journalctl -u pm2-groupai.service --since '10 minutes ago'
```

---

## What NOT to do

| ❌ Do not | Why |
|---|---|
| Run `pm2` commands as `root` for this app | A second PM2 daemon will compete with `pm2-groupai`. They race for port 3005, the loser ends up in a restart loop, and traffic ends up served by whichever bound first — usually with stale code. This was the actual root cause of the 2026-05-07 incident. |
| Run `node dist/server.js` directly (e.g. with `nohup`) | Bypasses PM2, no process supervision, no log rotation, no restart on crash, no reboot safety. |
| Edit files inside `dist/` by hand | The next `npm run build` will overwrite them. Edit `src/`, then `npm run build`. |
| Commit `dist/` to git | The repo no longer tracks `dist/`. Built artifacts are produced on the deploy host. |
| Change `PORT` in `.env` | nginx is configured to forward to `:3005`. Changing `PORT` requires a coordinated nginx update too. |
| Skip `pm2 save` after a process change | Reboots will resurrect an outdated process list. |
| Bypass the `groupai` user (e.g. deploy as `root` or your personal account) | All file ownership and PM2 state assumes `groupai`. Mixing users creates the duplicate-daemon class of bug. |

---

## Recovering from a competing daemon

If you ever see two `node dist/server.js` processes (or a root-owned PM2 daemon for this app), do this — root SSH required:

```bash
# 1. Identify the bad daemon (anything not owned by groupai)
ps -ef | grep -E 'PM2.*God Daemon' | grep -v grep

# 2. Snapshot its dump file before deleting (rollback insurance)
sudo cp /root/.pm2/dump.pm2 /root/dump.pm2.before-cleanup-$(date +%s).bak 2>/dev/null || true

# 3. Stop and remove the rogue PM2 ecosystem cleanly
sudo -u root pm2 list           # verify what's there
sudo -u root pm2 delete all
sudo -u root pm2 save --force
sudo -u root pm2 unstartup systemd
sudo -u root pm2 kill

# 4. Confirm only groupai's PM2 remains
ps -ef | grep -E 'PM2.*God Daemon' | grep -v grep

# 5. Restart the groupai cluster so it can bind the freed port
sudo -u groupai bash -lc 'pm2 restart sett-ai-server'

# 6. Verify port + health
ss -tlnp | grep ':3005'
curl -sS http://localhost:3005/health
```

This is documented in detail in `src/publicfiles/group-ai-pm2-cleanup-report.md` — refer to it for the canonical step-by-step.

---

## Rolling back

If a deploy goes wrong:

```bash
# As groupai
cd ~/sett_be
git log --oneline -10                  # find the previous good commit
git checkout <previous-good-sha>
npm run build
pm2 restart sett-ai-server
pm2 save
```

For database migrations specifically, **don't roll the schema back** unless you know exactly what you're doing — application code can usually run against a forward-migrated schema, but not vice versa. Prefer rolling forward with a fix.

---

## Environment variables

`.env` is the single source of truth, loaded by the `ecosystem.config.js` at PM2 startup. Critical vars:

| Var | Value | Notes |
|---|---|---|
| `PORT` | `3005` | Don't change without coordinating with nginx |
| `DATABASE_URL` | `postgresql://groupai:…@127.0.0.1:5432/groupai_db?schema=public` | Local socket; password URL-encoded |
| `NODE_ENV` | `production` | |
| `WBE_*` | hotel API credentials | |
| `GIATA_*` | hotel content credentials | |
| `SMTP_*` | Brevo SMTP | All transactional email |
| `WEBHOOK_SECRET`, `WORDPRESS_WEBHOOK_SECRET` | shared secrets for inbound webhooks | |

After editing `.env`, restart PM2 to pick up the changes:

```bash
pm2 restart sett-ai-server --update-env
pm2 save
```

---

## Quick reference

```bash
# Check status
pm2 list
pm2 logs sett-ai-server --lines 50

# Standard deploy
cd ~/sett_be && git pull && npm ci && npm run build && pm2 restart sett-ai-server && pm2 save

# Health check
curl -sS http://localhost:3005/health

# View live logs
pm2 logs sett-ai-server

# Run the resolver test suite (smoke test against live DB)
npx jest src/tests/destinationResolver.test.ts --runInBand --forceExit
```

---

## Open questions / things to fix when you have time

- nginx config has duplicate `server_name` warnings (pre-existing, cosmetic — `nginx -t` shows them but they don't affect routing).
- Document a backup / restore procedure for the PostgreSQL DB (currently nothing in this repo describes it).
- Consider adding a CI step that builds and runs the test suite on every push, so we never deploy a build that doesn't compile.

---

*Last updated: 2026-05-08*
