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
- Reset non-completed queue:
  - `node scripts/reset-queue.js`

## Runtime contract

- The dispatcher service in `plugin-entry.ts` polls queued jobs and drives ENRICH/TICK/COMPLETE turns.
- Orchestrator agent id defaults to `profile-enrich` unless overridden by `ENRICH_ORCH_AGENT_ID`.
- Findings are saved by `scripts/save-enrichment.js` to `findings`, and profile summary fields are updated in `profiles`.
