# Enrichment Architecture

The `enrichment` plugin is a standalone profile-enrichment core.

## Data model

- `profiles`: canonical profile rows (`profile_id`, identity, source metadata)
- `findings`: normalized enrichment findings linked by `profile_id`
- `enrichment_jobs`: queued/running/done work items per profile
- `enrichment_specialist_runs`: sub-agent run lifecycle per job
- `enrichment_events`: operational audit events

## Flow

1. Profiles are created/imported by any source adapter.
2. `enqueue.js` or `feed.js` writes queued jobs.
3. Dispatcher in `plugin-entry.ts` promotes queued job to running and sends ENRICH/TICK/COMPLETE messages to the orchestrator agent.
4. Orchestrator fans out to specialists and scorer.
5. `save-enrichment.js` writes findings and marks job done.
