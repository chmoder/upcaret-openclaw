# Installation automation — what the plugin can and can't do

## Primary install mechanism: the plugin

This skill ships as a native **OpenClaw plugin**. Installing the plugin handles:

- **Skill discovery** — `openclaw.plugin.json` declares `"skills": ["."]`, so OpenClaw discovers `SKILL.md` directly from the plugin directory. No manual copy to `workspace/skills/` is needed.
- **In-gateway dispatcher** — `plugin-entry.ts` registers a long-lived service that polls the SQLite queue and runs the orchestrator via the OpenClaw CLI in the **same gateway environment**. No PM2, no extra containers, and no separate “cron process” to keep alive.

## Install sequence

```bash
# 1. Install the plugin (ClawHub / marketplace id — or npm spec, e.g. advisor-lead-gen@3.1.0)
openclaw plugins install advisor-lead-gen

# 2. Enable the plugin
openclaw plugins enable advisor-lead-gen

# 3. Set BRAVE_API_KEY (required for enrichment)
openclaw config set env.BRAVE_API_KEY "<your-brave-search-api-key>"

# 4. Restart gateway — plugin activates, dispatcher is online
#    (If the advisor-enrich agent is missing, the plugin will create it and the
#    gateway may restart once more automatically.)
openclaw gateway restart
```
Every restart after that: the dispatcher service starts automatically. No manual steps.

## Upgrading to a new release

```bash
openclaw plugins update advisor-lead-gen
openclaw gateway restart
```

## What OpenClaw must own (not inside this folder)

| Task | Why the plugin can't fully automate it |
|------|----------------------------------------|
| **`openclaw config set env.*`** | Writes secrets and gateway env. Must run where your gateway reads config. |
| **Orchestrator = process with `sessions_*`** | The `advisor-enrich` agent must use the plugin directory as its workspace (`~/.openclaw/extensions/advisor-lead-gen`). The orchestrator is the `advisor-enrich` agent whose system prompt is `IDENTITY.md`. |
| **`sessions_send` / `TICK` with a real `sessionKey`** | Keys come from `sessions_list` at runtime. The plugin documents patterns; only a running client can call session tools. |
| **Named persistent session + agentId** | OpenClaw routes `agentTurn` jobs using `sessionTarget`. You must set `agentId` on each job to `advisor-enrich`; otherwise the gateway may fall back to the default agent. **Per-job `agentId`** is the binding. |

## What the plugin *does* automate on every boot

The plugin service (`plugin-entry.ts`) runs these checks idempotently:

1. **Node version** — requires 22.5+; logs an error with upgrade link if too old.
2. **Required files** — spot-checks `IDENTITY.md` and DB/session helper scripts; logs an error with reinstall instruction if missing.
3. **`BRAVE_API_KEY`** — logs an error with `openclaw config set` command if not set.
4. **DB schema** — calls `initSchema` from `scripts/db-init.js` (idempotent, safe every boot).
5. **Queue dispatch** — polls `enrichment_queue` and dispatches the next queued advisor when nothing else is running. If a row is stuck in `running` beyond the stale threshold, it is marked `failed` and the orchestrator session is reset so the queue can continue.

All errors are collected and logged together so the operator sees everything at once, with actionable fix commands.

## Script helpers (still available)

- **`npm run status`** — Shows the enrichment status dashboard.
- **`npm run bootstrap`** — Manual idempotent setup (Node check, file check, DB init). Rarely needed now that the plugin hook covers it.

## Queue an advisor (after setup is complete)

```bash
node scripts/enqueue-enrich.js --sec-id <SEC_ID>
# or:
npm run enqueue -- --sec-id <SEC_ID>
```

The in-gateway dispatcher picks it up within 5 seconds.

**⚠️ Do not add a TICK cron job.** TICK races with auto-resume and corrupts saves. Use TICK manually only if an enrichment is stuck after >5 minutes.

## Minimum OpenClaw version

**OpenClaw >= 2026.3.x is required.** The PM2-less design depends on plugin services (`api.registerService`) and the runtime command runner (`api.runtime.system.runCommandWithTimeout`). Upgrade before installing this plugin.
