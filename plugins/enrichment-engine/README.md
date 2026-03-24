# enrichment-engine (OpenClaw plugin)

Generic job queue dispatcher for OpenClaw enrichment pipelines.

## What it does

- Owns and initialises `enrichment.db` — a SQLite job queue (`enrichment_pipelines`, `enrichment_jobs`, `enrichment_specialist_runs`, `enrichment_events`).
- Runs a poll-loop dispatcher service inside the gateway that picks up `queued` jobs, resets the target agent session, spawns `openclaw agent --local --message <PREFIX>:<payload>`, and handles stale and failed runs automatically.
- Recovers orphaned `running` jobs on gateway restart.
- Skips dispatch for pipelines with `enabled = 0`.

Domain plugins such as `advisor-lead-gen` write jobs into `enrichment.db` and own all domain logic. This plugin handles only the dispatch infrastructure — it has no knowledge of what advisors or other domain entities are.

## Install

Install this plugin **before** any domain plugin that depends on it:

```bash
# If published in your marketplace/registry:
openclaw plugins install enrichment-engine

# If not published yet, install from an artifact or local path:
#   openclaw plugins install /path/to/enrichment-engine

openclaw plugins install advisor-lead-gen   # example consumer
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
#
# If your domain pipeline uses many specialists via sessions_spawn (e.g. advisors uses 10),
# raise the per-session active child cap to avoid spawn failures like:
#   "gateway max active children limit reached (5/5)"
openclaw config set agents.defaults.subagents.maxChildrenPerAgent 12
openclaw gateway restart
```

## Configuration

| Variable                      | Default                                | Purpose                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENRICHMENT_ENGINE_DB_PATH`   | `~/.openclaw/enrichment/enrichment.db` | Shared DB path — must match the setting used by every domain plugin                                                                                                                                      |
| `ENRICH_ENGINE_INTERVAL_MS`   | `5000`                                 | Poll interval in milliseconds                                                                                                                                                                            |
| `ENRICH_ENGINE_STALE_MINUTES` | `5`                                    | Minutes (wall clock from `started_at`) before a running job is marked **failed** — applies to all pipelines, including `advisors`. Keeps the queue from hanging when orchestration or specialists stall. |

Set `ENRICHMENT_ENGINE_DB_PATH` explicitly when the gateway uses a non-default state directory so that the engine and all domain plugins resolve to the same file.

For the `advisor-lead-gen` domain plugin, also ensure the domain DB path is consistent between extraction and save phases:

- Default domain DB: `~/.openclaw/advisor-lead-gen/advisors.db`
- Override (if needed): `openclaw config set env.ADVISOR_DOMAIN_DB_PATH "/absolute/path/to/advisors.db"`

## Manual DB init

```bash
node scripts/db-init.js [path/to/enrichment.db]
```

## Current consumers

| Plugin             | Pipeline                                 |
| ------------------ | ---------------------------------------- |
| `advisor-lead-gen` | `advisors` — SEC IAPD advisor enrichment |
