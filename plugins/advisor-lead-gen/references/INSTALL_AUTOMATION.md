# Installation automation — what the plugin can and can't do

## Primary install mechanism: the plugin

This skill ships as a native **OpenClaw plugin**. Installing the plugin handles:

- **Skill discovery** — `openclaw.plugin.json` declares `"skills": ["."]`, so OpenClaw discovers `SKILL.md` directly from the plugin directory. No manual copy to `workspace/skills/` is needed.
- **PM2 auto-start on every gateway boot** — `plugin-entry.ts` registers a `gateway:startup` hook that checks Node version, required files, `BRAVE_API_KEY`, DB schema, and starts `advisor-cron` via PM2 automatically. No manual PM2 startup command after the first install.

## Install sequence

```bash
# 1. Install the plugin (links in place for local dev)
openclaw plugins install -l /path/to/advisor-lead-gen

# From ClawHub (when published):
openclaw plugins install advisor-lead-gen

# 2. Enable the plugin
openclaw plugins enable advisor-lead-gen

# 3. Set BRAVE_API_KEY (required for enrichment)
openclaw config set env.BRAVE_API_KEY "<your-brave-search-api-key>"

# 4. Create the orchestrator agent
#    Plugin path is the install location managed by OpenClaw:
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/extensions/advisor-lead-gen

# Via Docker:
docker compose run --rm -T openclaw-cli agents add advisor-enrich \
  --workspace "/home/node/.openclaw/extensions/advisor-lead-gen"

# 5. Restart gateway — plugin activates, PM2 starts, cron is online
openclaw gateway restart
```

Every restart after that: the `gateway:startup` hook fires automatically, PM2 starts `advisor-cron` if it is not already running. No manual steps ever again.

## What OpenClaw must own (not inside this folder)

| Task | Why the plugin can't fully automate it |
|------|----------------------------------------|
| **`openclaw agents add`** | Creates entries in gateway config (`openclaw.json`) and workspaces. Requires the **OpenClaw CLI** on the host that runs the gateway. |
| **`openclaw config set env.*`** | Writes secrets and gateway env. Must run where your gateway reads config. |
| **Orchestrator = process with `sessions_*`** | The `advisor-enrich` agent must use the plugin directory as its workspace (`~/.openclaw/extensions/advisor-lead-gen`). The orchestrator is the `advisor-enrich` agent whose system prompt is `IDENTITY.md`. |
| **`sessions_send` / `TICK` with a real `sessionKey`** | Keys come from `sessions_list` at runtime. The plugin documents patterns; only a running client can call session tools. |
| **Named persistent session + agentId** | OpenClaw routes `agentTurn` jobs using `sessionTarget`. You must set `agentId` on each job to `advisor-enrich`; otherwise the gateway may fall back to the default agent. **Per-job `agentId`** is the binding. |

## What the plugin *does* automate on every boot

The `gateway:startup` hook (`plugin-entry.ts`) runs these checks idempotently:

1. **Node version** — requires 22.5+; logs an error with upgrade link if too old.
2. **Required files** — spot-checks `IDENTITY.md`, `scripts/dispatch-cron.js`, `ecosystem.config.js`; logs an error with reinstall instruction if missing.
3. **`BRAVE_API_KEY`** — logs an error with `openclaw config set` command if not set.
4. **DB schema** — calls `initSchema` from `scripts/db-init.js` (idempotent, safe every boot).
5. **PM2 + advisor-cron** — if `advisor-cron` is not `online`, runs `pm2 start ecosystem.config.js && pm2 save --force`. Logs a clear error if `pm2` is not on PATH.

All errors are collected and logged together so the operator sees everything at once, with actionable fix commands.

## One-time prerequisite: PM2 global install

PM2 must be installed globally before the first gateway restart. The plugin will log a clear error if it is missing:

```bash
npm install -g pm2
# then:
openclaw gateway restart
```

## Script helpers (still available)

- **`npm run setup:openclaw`** — Runs `openclaw plugins install -l` and `openclaw plugins enable` automatically if the CLI is on PATH, then prints the remaining manual steps (API key, agents add, gateway restart).
- **`npm run env:help`** — Lists all environment variables and their purpose.
- **`npm run status`** — Shows the enrichment status dashboard.
- **`npm run bootstrap`** — Manual idempotent setup (Node check, file check, DB init). Rarely needed now that the plugin hook covers it.

## Queue an advisor (after setup is complete)

```bash
node scripts/enqueue-enrich.js --sec-id <SEC_ID>
# or:
npm run enqueue -- --sec-id <SEC_ID>
```

The PM2-managed `dispatch-cron.js` picks it up within 5 seconds.

**⚠️ Do not add a TICK cron job.** TICK races with auto-resume and corrupts saves. Use TICK manually only if an enrichment is stuck after >5 minutes.

## Minimum OpenClaw version

**OpenClaw >= 2026.3.x is required.** Earlier versions had a bug (fixed in PR #29515, merged March 16 2026) that silently cleared plugin-registered `gateway:startup` hooks on every restart, causing the hook to never fire. Upgrade before installing this plugin.
