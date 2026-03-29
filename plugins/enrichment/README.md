# enrichment (OpenClaw plugin)

Standalone, source-agnostic profile enrichment plugin.

## What this plugin owns

- Unified database: `enrichment.db` (`profiles`, `findings`, jobs, specialist runs, events)
- Queue dispatcher service (`plugin-entry.ts`)
- Orchestrator prompt (`IDENTITY.md`)
- Specialist prompts (`agents/*.md`)
- Enqueue/feed/status/save scripts

## What this plugin does not own

- Source-specific imports (SEC, CSV, CRM) beyond the generic profile schema

## Install

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw gateway restart
```

On gateway start the plugin adds `profile-enrich` plus namespaced specialist agent entries (`enrich-profile`, `enrich-email`, `enrich-phone`, `enrich-website`, `enrich-linkedin`, `enrich-cert`, `enrich-award`, `enrich-speaking`, `enrich-news`, `enrich-network`, `enrich-scorer`) to `openclaw.json` if missing, and sets `profile-enrich.subagents.allowAgents` to those IDs so `sessions_spawn` can resolve and run them.

If running locally from this repo:

```bash
openclaw plugins install ./plugins/enrichment
openclaw plugins enable enrichment
openclaw gateway restart
```

## Environment

- `ENRICHMENT_DB_PATH` (optional): absolute path to `enrichment.db`
- `ENRICH_ORCH_AGENT_ID` (optional): defaults to `profile-enrich`
- `ENRICHMENT_WORKSPACE` (optional): workspace path for orchestrator scripts
- `ENRICH_ENGINE_INTERVAL_MS` (optional): dispatcher poll interval
- `ENRICH_ENGINE_STALE_MINUTES` (optional): stale running-job timeout

## Common scripts

```bash
npm run db:init
npm run enqueue -- --profile-id manual:123
npm run feed -- --limit 20
npm run status
```
