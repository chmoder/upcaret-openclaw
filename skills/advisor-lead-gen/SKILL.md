---
name: sec-iapd-advisor-enrichment
description: >
  Lead gen and advisor enrichment for financial advisors via the SEC IAPD database. Use when the user says "set up the lead gen skill", "install the lead gen skill", "configure advisor enrichment", "set up advisor lead gen", "onboard the advisor skill", "enrich advisors", or asks to pull/enrich SEC IAPD advisors. Handles SEC download, multi-agent enrichment (requires BRAVE_API_KEY), scoring, and export. Install location: ~/.openclaw/workspace/skills/advisor-lead-gen/ — this directory is also the orchestrator workspace (no second copy needed).
---

# SEC IAPD Advisor Enrichment Skill v3.1

**SEC download plus multi-agent enrichment for IAPD advisors.**

This skill has two modes:

- **SEC download only**: pull advisor rows into `advisors.db` with no enrichment keys.
- **Enrichment**: send advisor payloads to a persistent OpenClaw orchestrator, which fans out to specialist agents and writes scored results back to SQLite.

## Read This First

Models operating this skill should follow `references/ASSISTANT_GUIDE.md`.

**Install:** copy the skill to `~/.openclaw/workspace/skills/advisor-lead-gen/` then say **"set up the lead gen skill"** in chat. The main agent reads this file from there and follows **`references/SETUP_WIZARD.md`** — bootstrap, register `advisor-enrich` (workspace = this directory, no second copy), collect `BRAVE_API_KEY`, verify. Full packaging checklist: **`references/DISTRIBUTION.md`**. Default model: **`anthropic/claude-haiku-4-5`** (see **`references/MODEL_DEFAULTS.md`**).

Day-to-day:

- **Setup trigger** ("set up the lead gen skill", "install", "onboard"): read `references/ASSISTANT_GUIDE.md` §0 and **execute immediately** — bootstrap, register agent, ask for key. Do not present options.
- **Enrichment / status**: follow `references/ASSISTANT_GUIDE.md` §1 decision tree exactly. Short form: run `node scripts/enqueue-enrich.js --sec-id <SEC_ID>` — the `dispatch-cron.js` process picks it up within 5 seconds, resets the session, and fires ENRICH automatically. Do NOT send ENRICH or TICK manually. Never use `sessions_spawn` (ACP errors from it are noise). Never mention ACP, Discord, or Slack as requirements.
- **Never** imply enrichment succeeded without a real `DONE:` from the orchestrator.
- **Never fabricate data, install packages, create files, or workaround failures silently** — see `references/ASSISTANT_GUIDE.md` Hard rules.

## First-Time Setup

1. Place this skill at **`~/.openclaw/workspace/skills/advisor-lead-gen/`** (`package.json` at the root). See **`references/SETUP_WIZARD.md`**.
2. Run **`npm run bootstrap`** in that directory.
3. Run **`npm run setup:openclaw`** — read the printed `openclaw agents add advisor-enrich --workspace <this-dir>` command and run it.
4. Set `env.BRAVE_API_KEY` via the printed `openclaw config set` command. Optionally: `npm run setup:openclaw -- --apply-env` if the key is already exported.
5. Optionally run `npm run extract` to preload SEC advisor rows into `advisors.db`.

For the full operator boundary, read `references/INSTALL_AUTOMATION.md`.

## Runtime Contract

Enrichment requires a **persistent OpenClaw agent session** with Session Tools such as `sessions_spawn`, `sessions_yield`, and `sessions_history`. One-off shells or ordinary subagents are not a substitute. For **cron**-driven runs, set **`agentId`** on each job to the orchestrator agent (see `references/OPENCLAW_RUNTIME.md` §3 and `npm run setup:openclaw`). The same doc covers the send/poll lifecycle and `timeoutSeconds: 0` guidance.

The orchestrator is a backend capability. End users should normally interact through a main agent or app flow, not by hand-crafting `sessions_send` calls.

### What The Main Agent Should Do

Natural-language requests like these are the intended interface:

- "Enrich 10 advisors from Nebraska."
- "Pull new advisors from SEC and enrich them."
- "What is the lead score for CRD 4167394?"

Under the hood, the main agent or routing layer should translate those requests into the orchestrator protocol described below. Routing guidance belongs in `references/MAIN_AGENT_ROUTING.md`, not in this skill file.

### What `scripts/orchestrator.js` Actually Handles

`scripts/orchestrator.js` is intentionally narrow. It handles:

- `ENRICH:{...advisor_json...}` to start an enrichment run.
- `TICK` to advance or poll a run that has not finished yet.
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
- **Enrichment**: requires web discovery and may use optional provider keys.

| Variable            | Required | Purpose                                                          |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `BRAVE_API_KEY`     | Yes      | Web search for advisor discovery and verification                |
| `ANTHROPIC_API_KEY` | Optional | LLM use in specialist sub-sessions, if your model setup needs it |
| `FIRECRAWL_API_KEY` | Optional | Paid fetcher                                                     |
| `HUNTER_API_KEY`    | Optional | Email verification and enrichment                                |

Show the full env help with:

```bash
npm run env:help
```

Example setup:

```bash
export BRAVE_API_KEY="your-brave-key"
export ANTHROPIC_API_KEY="sk-..."
export FIRECRAWL_API_KEY="fc-..."
export HUNTER_API_KEY="hunter-key"
```

Or inject them through OpenClaw config:

```bash
openclaw config set env.BRAVE_API_KEY "your-key"
openclaw config set env.ANTHROPIC_API_KEY "sk-..."
```

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

Print OpenClaw setup commands:

```bash
npm run setup:openclaw
```

SEC download only:

```bash
node scripts/extract-advisors.js --state NE --limit 50
```

Local orchestrator testing:

```bash
npm run orchestrate
```

## Repository Layout

```text
advisor-lead-gen/
├── SKILL.md
├── package.json
├── advisors.db
├── agents/
│   ├── orchestrator.md
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
│   ├── orchestrator.js
│   ├── extract-advisors.js
│   ├── db-init.js
│   ├── bootstrap.js
│   ├── openclaw-setup.js
│   ├── status-dashboard.js
│   └── env-help.js
└── references/
    ├── ASSISTANT_GUIDE.md
    ├── INSTALL_AUTOMATION.md
    ├── MAIN_AGENT_ROUTING.md
    └── OPENCLAW_RUNTIME.md
```

## Data And Monitoring

All runtime data is stored in `advisors.db`, which is created or upgraded by `npm run db:init` and by orchestrator startup checks.

Important tables include:

- `advisors` for core advisor records, enrichment timestamps, and lead scores.
- `advisor_findings` for extracted findings with confidence and source data.
- `pending_enrichments` for per-specialist run state while enrichment is in progress.

Keep `advisors.db` as local runtime data. Do not commit real advisor data or secrets.

The detailed schema and any SQL-level monitoring examples should live with the implementation, especially `scripts/db-init.js` and the runtime references, rather than in this top-level skill file.

## Cost

Approximate external-search cost is low; the main constraint is usually provider quotas, especially Brave Search limits.

## Troubleshooting

### Long-Running Jobs And Disconnected Sessions

If an import or enrichment runs for a long time and the device sleeps, the network connection may drop even if the backend job is still progressing.

What to do:

1. Retry if the operation is not resumable.
2. Keep the device awake during long-running interactive sessions.
3. Prefer async initiation plus polling instead of one long-lived blocking request.
4. If a proxy or server timeout closes the connection, increase that timeout or move the client flow to async polling.
