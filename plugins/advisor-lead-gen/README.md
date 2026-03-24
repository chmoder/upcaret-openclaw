# advisor-lead-gen (OpenClaw plugin)

SEC IAPD advisor domain layer. Requires **`enrichment-engine`** for dispatch.

## What this plugin owns

- **SEC data download:** `scripts/extract-advisors.js` → `advisors.db` (entities, advisor_profiles, findings)
- **Orchestrator skill:** `IDENTITY.md` (system prompt) + `agents/*.md` — the `advisor-enrich` agent that fans out to specialist sub-agents and scores results
- **Domain scripts:** enqueue, record, and save enrichment results; status dashboard; bootstrap

## What it does NOT own

- **Dispatch** — picking up queued jobs and spawning the orchestrator process is handled entirely by `enrichment-engine` and its poll-loop service
- **`enrichment.db`** — the job queue DB is owned by `enrichment-engine`; this plugin only writes to it via `engine-db.js`

## Install

Install `enrichment-engine` first, then this plugin:

```bash
# If published in your marketplace/registry:
openclaw plugins install enrichment-engine
openclaw plugins install advisor-lead-gen

# If `enrichment-engine` is not published yet, install from an artifact/path instead:
#   openclaw plugins install /path/to/enrichment-engine
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
# Set BRAVE_API_KEY: Settings → Environment variables, or openclaw config set env.BRAVE_API_KEY "<key>"
#
# Required for advisor enrichment (10 specialists):
# Without this you may see: "gateway max active children limit reached (5/5)"
openclaw config set agents.defaults.subagents.maxChildrenPerAgent 12
# Optional override if you do NOT want the default DB location:
# openclaw config set env.ADVISOR_DOMAIN_DB_PATH "/absolute/path/to/advisors.db"
openclaw agents add advisor-enrich --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

**After you change this repo:** reinstall into OpenClaw from your checkout so `~/.openclaw/extensions/...` picks up the new files, then restart the gateway (same `plugins install` lines as above, with `./plugins/enrichment-engine` then `./plugins/advisor-lead-gen` from the monorepo root).

Bootstrap the domain DB and load SEC advisors:

```bash
npm run bootstrap
# Optional: apply the OpenClaw sub-agent limit automatically (still requires restart):
# npm run bootstrap -- --apply-openclaw-config
npm run extract -- --state <STATE> --limit <N>
```

## Where the domain DB lives

- Default: `~/.openclaw/advisor-lead-gen/advisors.db`
- Explicit override: set `env.ADVISOR_DOMAIN_DB_PATH` in OpenClaw config (for example, `plugins/advisor-lead-gen/advisors.db` during local development)

All domain scripts (`bootstrap`, `extract`, `enqueue`, `feed`, `next-advisor`, `status-dashboard`, `save-enrichment`) now resolve the DB path the same way, so extraction and enrichment writes stay in sync.

In chat: **"set up the lead gen skill"** — the agent follows `references/SETUP_WIZARD.md`.

See **`SKILL.md`**, **`references/DISTRIBUTION.md`**, and **`references/INSTALL_AUTOMATION.md`** for full setup and packaging details.
