---
name: profile-enrichment
description: >
  Source-agnostic profile enrichment platform. Use when users ask to enrich people,
  enqueue enrichment runs, check enrichment status, or operate profile findings.
---

# Profile Enrichment Skill

This plugin enriches profiles regardless of source system.

Profiles can be imported from any system (`source_system`, `source_key`, `source_data`)
and then enriched through the same queue and orchestrator flow.

## Typical operations

- Enqueue a specific profile:
  - `node scripts/enqueue.js --profile-id <profile_id>`
- Batch enqueue due profiles:
  - `node scripts/feed.js --limit 25`
- Check status dashboard:
  - `node scripts/status-dashboard.js --format markdown`
- Pull profiles/findings (LLM-friendly JSON, via `profile-research` wrapper):
  - `node plugins/profile-research/scripts/pull-data.js profiles --limit 25 --q "nebraska medicine"`
  - `node plugins/profile-research/scripts/pull-data.js profile --profile-id <profile_id> --findings-limit 50`
  - `node plugins/profile-research/scripts/pull-data.js findings --limit 50 --finding-type email`
- Reset non-completed queue:
  - `node scripts/reset-queue.js`

## Runtime contract

- The dispatcher service in `plugin-entry.ts` polls queued jobs and drives ENRICH/TICK/COMPLETE turns.
- Orchestrator agent id defaults to `profile-enrich` unless overridden by `ENRICH_ORCH_AGENT_ID`.
- Findings are saved by `scripts/save-enrichment.js` to `findings`, and profile summary fields are updated in `profiles`.

## Cross-plugin note (ACP)

Delegating to other agents with **`runtime: "acp"`** needs the **`@openclaw/acpx`** plugin and `acp` config on the gateway; installing or enabling **enrichment** does not set that up. The enrichment orchestrator uses native **subagent** specialists by default. See `VALIDATION_RUNBOOK.md` (ACP section) and, at repo root, `config/snippets/openclaw-acp-acpx.json`.
