---
name: sec-iapd-advisor-enrichment
description: >
  Lead gen and advisor enrichment for financial advisors via the SEC IAPD database. Use when the user says "set up the lead gen skill", "install the lead gen skill", "configure advisor enrichment", "set up advisor lead gen", "onboard the advisor skill", "enrich advisors", or asks to pull/enrich SEC IAPD advisors. This plugin provides the SEC download, orchestrator skill, specialist agents, and lead scoring. Dispatch is handled by the companion enrichment-engine plugin. Both must be installed (if `enrichment-engine` is not published in the user’s marketplace/registry yet, it must be installed from an artifact/path).
---

# SEC IAPD Advisor Enrichment Skill v3.1

**SEC IAPD domain layer — data download, orchestrator skill, specialist agents, and lead scoring.**

This plugin provides two capabilities:

- **SEC download**: pull advisor rows into `advisors.db` with no enrichment keys required.
- **Orchestrator skill**: the `advisor-enrich` agent fans out to specialist sub-agents and writes scored results back to `advisors.db`.

**Dispatch is not part of this plugin.** The `enrichment-engine` plugin owns the job queue (`enrichment.db`) and the poll-loop that picks up queued jobs and spawns the orchestrator. Both plugins must be installed and enabled for enrichment to work.

## Read This First

Models operating this skill should follow `references/ASSISTANT_GUIDE.md`.

**Install:** `openclaw plugins install enrichment-engine` first, then `openclaw plugins install advisor-lead-gen` (or say **"set up the lead gen skill"** in chat). If `enrichment-engine` is not published in the user’s marketplace/registry, install it from an artifact/path instead (same end state). `enrichment-engine` must be enabled before this plugin — it owns the job queue and dispatcher. The advisor plugin registers `SKILL.md` automatically — no copy to `workspace/skills/` needed. The main agent follows **`references/SETUP_WIZARD.md`** — register `advisor-enrich` (workspace = `~/.openclaw/extensions/advisor-lead-gen/`), restart gateway, and rebuild `advisors.db` (breaking schema change). Full packaging checklist: **`references/DISTRIBUTION.md`**.

Day-to-day:

- **Setup trigger** ("set up the lead gen skill", "install", "onboard"): read `references/ASSISTANT_GUIDE.md` §0 and **execute immediately** — bootstrap, register agent, restart gateway. Do not present options.
- **Enrichment / status**: follow `references/ASSISTANT_GUIDE.md` §1 decision tree exactly. Short form: run `node scripts/enqueue-enrich.js --sec-id <SEC_ID>` — this writes an engine job into `enrichment.db` and the `enrichment-engine` plugin dispatches it within a few seconds. Do NOT send ENRICH or TICK manually.
- **Never** imply enrichment succeeded without a real `DONE:` from the orchestrator.
- **Never fabricate data, install packages, create files, or workaround failures silently** — see `references/ASSISTANT_GUIDE.md` Hard rules.

## First-Time Setup

1. Install both plugins: `openclaw plugins install enrichment-engine` and `openclaw plugins install advisor-lead-gen` (or install `enrichment-engine` from an artifact/path if it is not published yet).
2. Enable both plugins: `openclaw plugins enable enrichment-engine` and `openclaw plugins enable advisor-lead-gen`
3. Create the orchestrator agent: `openclaw agents add advisor-enrich --workspace ~/.openclaw/extensions/advisor-lead-gen`
4. Restart the gateway: `openclaw gateway restart` — engine dispatcher becomes live.
5. Rebuild domain DB and preload SEC advisors: `rm -f advisors.db && npm run bootstrap && npm run extract -- --state <STATE> --limit <N>`.

For the full operator boundary, read `references/INSTALL_AUTOMATION.md`.

## Runtime Contract

Enrichment requires a **persistent OpenClaw agent session** with Session Tools such as `sessions_spawn`, `sessions_yield`, and `sessions_history`. One-off shells or ordinary subagents are not a substitute. Engine-dispatched runs still require **`agentId`** to resolve the orchestrator correctly (see `references/OPENCLAW_RUNTIME.md`).

The orchestrator is a backend capability. End users should normally interact through a main agent or app flow, not by hand-crafting `sessions_send` calls.

### What The Main Agent Should Do

Natural-language requests like these are the intended interface:

- "Enrich 10 advisors from Nebraska."
- "Pull new advisors from SEC and enrich them."
- "What is the lead score for CRD 4167394?"

Under the hood, the main agent or routing layer should translate those requests into the orchestrator protocol described below. Routing guidance belongs in `references/MAIN_AGENT_ROUTING.md`, not in this skill file.

### What The Orchestrator Agent Handles

The `advisor-enrich` agent (system prompt: `IDENTITY.md`) is intentionally narrow. It handles:

- `ENRICH:{...advisor_json...}` to start an enrichment run.
- `TICK` to advance a run that has not finished yet (manual recovery only).
- `ENV` and built-in help messages for runtime inspection.
- `STATUS` (or `/leadgen status`) to return a raw status dashboard payload from `advisors.db`.

It does **not** implement export workflows, retry queues, or arbitrary slash commands. Those behaviors belong in the main agent, app layer, or surrounding automation.

### Core Message Pattern

```javascript
sessions_send({
  sessionKey: "session:advisor-orchestrator",
  agentId: "advisor-enrich",
  message: 'ENRICH:{"sec_id":4167394,"first_name":"Chris","last_name":"Leaver","firm_name":"THRIVENT ADVISOR NETWORK, LLC","city":"Fremont","state":"NE","crd":"4167394"}',
  timeoutSeconds: 0,
});
```

**`agentId: "advisor-enrich"` is required.** Without it the gateway does not know which agent owns `session:advisor-orchestrator` and may misroute. If the session does not exist yet, `sessions_send` with `agentId` creates it — do not use `sessions_spawn` as a substitute.

`ENRICH:{...}` starts the run, but completion is multi-turn. If `DONE:{...}` does not appear quickly, the caller must keep sending `TICK` and checking session history until the run completes. Do not assume a single blocking request will carry the full workflow.

## How It Works

When the main agent delegates an advisor to the orchestrator, the orchestrator fans out to specialist agents and then scores the merged result.

| Agent    | Job                                                                  |
| -------- | -------------------------------------------------------------------- |
| profile  | Finds verified profile URLs via CRD                                  |
| email    | Extracts and validates email addresses                               |
| phone    | Extracts and validates phone numbers                                 |
| website  | Finds official firm websites                                         |
| linkedin | Finds personal LinkedIn profiles                                     |
| cert     | Extracts certifications such as CFP, CFA, CPA, Series 63, 65, and 66 |
| award    | Finds awards and recognitions                                        |
| speaking | Finds speaking engagements                                           |
| news     | Finds news mentions                                                  |
| network  | Finds colleagues and team members                                    |
| scorer   | Validates all findings and scores the lead 1 to 5                    |

## Environment

There are two distinct workflows:

- **SEC download only**: no API keys required.
- **Enrichment**: **`BRAVE_API_KEY` is required** (Brave Search for web discovery). Other keys below are optional depending on your runtime/tools.

| Variable            | Required | Purpose                                                          |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `BRAVE_API_KEY`     | Yes      | Brave Search API key for web discovery during enrichment         |
| `ANTHROPIC_API_KEY` | Optional | LLM use in specialist sub-sessions, if your model setup needs it |
| `FIRECRAWL_API_KEY` | Optional | Firecrawl (URL scrape / `web_fetch`) when your gateway is wired to Firecrawl |
| `HUNTER_API_KEY`    | Optional | Email verification and enrichment                                |

Keys are stored in **OpenClaw config** under `env` (same values the gateway sees). Prefer **OpenClaw Settings → Environment variables** in the UI, or the CLI:

```bash
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw config set env.ANTHROPIC_API_KEY "sk-..."
openclaw config set env.FIRECRAWL_API_KEY "fc-..."
openclaw config set env.HUNTER_API_KEY "hunter-key"
```

Optional keys only apply if your runtime/tools use those providers. See `references/SETUP_WIZARD.md` and `references/INSTALL_AUTOMATION.md`.

Shell `export` is only for one-off scripts outside the gateway; plugins and dispatch use config-backed `env`, not your interactive shell.

Never hardcode API keys in tracked files.

## Common Commands

Bootstrap and schema setup:

```bash
npm run bootstrap
```

Status dashboard (raw JSON by default):

```bash
npm run status
```

Optional: render Markdown directly (useful for humans; chat agents usually prefer JSON):

```bash
npm run status -- --format markdown
```

OpenClaw setup: follow `references/INSTALL_AUTOMATION.md`.

SEC download only:

```bash
node scripts/extract-advisors.js --state NE --limit 50
```

Queue one advisor for enrichment (enrichment-engine picks it up within ~5s):

```bash
node scripts/enqueue-enrich.js --sec-id 4167394
```

Batch-enqueue advisors due for enrichment (never enriched first, then stale):

```bash
npm run feed -- --limit 25
npm run feed -- --state NE --limit 50
npm run feed -- --threshold-days 30 --limit 100
npm run feed -- --dry-run          # preview without writing jobs
```

## Repository Layout

```text
advisor-lead-gen/
├── SKILL.md
├── IDENTITY.md              ← orchestrator system prompt (advisor-enrich agent)
├── ARCHITECTURE.md
├── package.json
├── advisors.db              ← runtime data (not committed)
├── agents/
│   ├── profile.md
│   ├── email.md
│   ├── phone.md
│   ├── website.md
│   ├── linkedin.md
│   ├── cert.md
│   ├── award.md
│   ├── speaking.md
│   ├── news.md
│   ├── network.md
│   └── scorer.md
├── scripts/
│   ├── extract-advisors.js
│   ├── enqueue-enrich.js    ← queue one advisor for enrichment
│   ├── feed.js              ← batch-enqueue advisors due for enrichment
│   ├── engine-db.js         ← helper for enrichment.db access
│   ├── record-enrichment.js
│   ├── save-enrichment.js
│   ├── next-advisor.js
│   ├── reset-queue.js
│   ├── db-init.js
│   ├── db.js
│   ├── bootstrap.js
│   ├── status-dashboard.js
│   └── check-skill-layout.js
└── references/
    ├── ASSISTANT_GUIDE.md
    ├── INSTALL_AUTOMATION.md
    ├── MAIN_AGENT_ROUTING.md
    ├── OPENCLAW_RUNTIME.md
    ├── SETUP_WIZARD.md
    ├── DISTRIBUTION.md
    └── MODEL_DEFAULTS.md
```

## Data And Monitoring

Runtime data is split across two DBs with distinct ownership:

| DB | Owner plugin | Purpose |
|---|---|---|
| `advisors.db` | **advisor-lead-gen** | Domain records: entities, advisor_profiles, findings, lead scores |
| `enrichment.db` | **enrichment-engine** | Job queue: enrichment_pipelines, enrichment_jobs, specialist runs, events |

Key tables in `advisors.db`:

- `entities` — core advisor entities, latest enrichment timestamps, and lead scores.
- `advisor_profiles` — SEC IAPD fields tied to each entity.
- `findings` — extracted findings with confidence and source data.

Keep `advisors.db` as local runtime data. Do not commit real advisor data or secrets.

The detailed schema lives in `scripts/db-init.js` (advisors.db) and in the enrichment-engine plugin's `scripts/db-init.js` (enrichment.db).

## Cost

Approximate external-search cost is low; the main constraint is usually provider quotas, especially Brave Search limits.

## Troubleshooting

### "Cannot find module 'better-sqlite3'" (or any sqlite module)

This skill uses **`node:sqlite`** — a built-in Node.js module available from Node 22.5+. There are no npm database dependencies. If you see this error:

- Do **not** run `npm install better-sqlite3`, `npm install sqlite3`, or any variant.
- Run `node --version` — it must be ≥ 22.5. If it is not, upgrade Node.
- Run `npm run bootstrap` to verify the environment is correct.
- Never access the DB with ad-hoc `node -e "require('better-sqlite3')..."`. Use the provided scripts only: `npm run status`, `node scripts/enqueue-enrich.js`, etc.

### Queue is stuck / enrichment never starts

The queue is drained by the **enrichment-engine** plugin’s dispatcher service. If a queued row never starts:

- Verify both plugins are enabled: `openclaw plugins list` should show `enrichment-engine` and `advisor-lead-gen` enabled.
- Restart the gateway and check logs for `SETUP ERRORS` from either plugin.
- If a job is stuck in `running` for a long time, engine stale detection marks it `failed` and moves on.

### Long-Running Jobs And Disconnected Sessions

If an import or enrichment runs for a long time and the device sleeps, the network connection may drop even if the backend job is still progressing.

What to do:

1. Retry if the operation is not resumable.
2. Keep the device awake during long-running interactive sessions.
3. Prefer async initiation plus polling instead of one long-lived blocking request.
4. If a proxy or server timeout closes the connection, increase that timeout or move the client flow to async polling.
