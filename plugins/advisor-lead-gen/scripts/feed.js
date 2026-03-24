#!/usr/bin/env node
/**
 * feed.js — Batch-enqueue advisors due for enrichment.
 *
 * Finds advisors due for enrichment (never enriched first, then stale by
 * threshold) and writes them to enrichment_jobs in one pass. The
 * enrichment-engine plugin dispatches each job automatically — no manual
 * ENRICH send required.
 *
 * Usage:
 *   node scripts/feed.js
 *   node scripts/feed.js --limit 50
 *   node scripts/feed.js --state NE --limit 25
 *   node scripts/feed.js --threshold-days 30 --limit 100
 *   node scripts/feed.js --dry-run
 *
 * Flags:
 *   --limit N            Max advisors to enqueue this run (default: 10)
 *   --state XX           Filter to advisors in this US state (e.g. NE, CA)
 *   --threshold-days N   Days before a completed enrichment is stale (default: 90)
 *   --dry-run            Print what would be queued without writing any jobs
 *
 * Output:
 *   QUEUED:<sec_id>             — job written to enrichment_jobs
 *   WOULD_QUEUE:<sec_id>        — dry-run only, no write
 *   SKIP:<sec_id>:already_active — advisor already queued or running
 *   FEED_DONE:{...summary}      — final summary line (always printed)
 *   ERROR:<message>             — unexpected failure (exits 1)
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import { dbGet, openDb } from "./db.js";
import { initSchema } from "./db-init.js";
import {
  advisorEntityId,
  ensureAdvisorPipeline,
  initEngineSchema,
  newJobId,
  openEngineDb,
  resolveEngineDbPath,
} from "./engine-db.js";

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD_DAYS = 90;

function parseArgs(argv) {
  const args = argv.slice(2);
  let limit = DEFAULT_LIMIT;
  let state = null;
  let thresholdDays = DEFAULT_THRESHOLD_DAYS;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === "--state" && args[i + 1]) {
      state = args[++i].toUpperCase();
    } else if (args[i] === "--threshold-days" && args[i + 1]) {
      thresholdDays = parseInt(args[++i], 10);
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { limit, state, thresholdDays, dryRun };
}

function pickNext(db, { stateFilter, thresholdDays, blocked }) {
  const blockedArr = [...blocked];
  const blockedClause =
    blockedArr.length > 0
      ? `AND ap.sec_id NOT IN (${blockedArr.map(() => "?").join(", ")})`
      : "";

  // Priority 1: never enriched.
  const neverEnriched = dbGet(
    db,
    `SELECT ap.sec_id, ap.first_name, ap.last_name, ap.firm_name, ap.city, ap.state
     FROM advisor_profiles ap
     JOIN entities e ON e.entity_id = ap.entity_id
     WHERE e.enriched_at IS NULL
       ${stateFilter}
       ${blockedClause}
     ORDER BY ap.sec_id ASC
     LIMIT 1`,
    blockedArr,
  );
  if (neverEnriched) return neverEnriched;

  // Priority 2: stale (enriched_at older than threshold).
  return (
    dbGet(
      db,
      `SELECT ap.sec_id, ap.first_name, ap.last_name, ap.firm_name, ap.city, ap.state
       FROM advisor_profiles ap
       JOIN entities e ON e.entity_id = ap.entity_id
       WHERE e.enriched_at IS NOT NULL
         ${stateFilter}
         AND datetime(e.enriched_at) < datetime('now', '-${thresholdDays} days')
         ${blockedClause}
       ORDER BY e.enriched_at ASC
       LIMIT 1`,
      blockedArr,
    ) ?? null
  );
}

function main() {
  const { limit, state, thresholdDays, dryRun } = parseArgs(process.argv);

  if (!Number.isFinite(limit) || limit < 1) {
    console.error("ERROR: --limit must be a positive integer");
    process.exit(1);
  }
  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) {
    console.error("ERROR: --threshold-days must be a positive integer");
    process.exit(1);
  }

  const stateFilter = state ? `AND ap.state = '${state.replace(/'/g, "''")}'` : "";

  const db = openDb();
  const engineDb = openEngineDb(resolveEngineDbPath());
  try {
    initSchema(db);
    initEngineSchema(engineDb);
    if (!dryRun) ensureAdvisorPipeline(engineDb);

    // Seed blocked set from currently active jobs so we never double-enqueue.
    const blocked = new Set(
      engineDb
        .prepare(
          `SELECT entity_id FROM enrichment_jobs
           WHERE pipeline_id='advisors' AND status IN ('queued','running')`,
        )
        .all()
        .map((r) => Number(String(r.entity_id || "").replace(/^advisor:/, "")))
        .filter((n) => Number.isFinite(n)),
    );

    const agentId = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
    let queued = 0;
    let skipped = 0;
    let stopped = "limit_reached";

    for (let i = 0; i < limit; i++) {
      const advisor = pickNext(db, { stateFilter, thresholdDays, blocked });
      if (!advisor) {
        stopped = "no_more_due";
        break;
      }

      const secId = Number(advisor.sec_id);
      const entityId = advisorEntityId(secId);

      // Race guard: re-check active status in case something else enqueued concurrently.
      const active = engineDb
        .prepare(
          `SELECT status FROM enrichment_jobs
           WHERE pipeline_id='advisors' AND entity_id=? AND status IN ('queued','running')
           LIMIT 1`,
        )
        .get(entityId);
      if (active) {
        console.log(`SKIP:${secId}:already_active`);
        skipped++;
        blocked.add(secId);
        continue;
      }

      if (dryRun) {
        console.log(`WOULD_QUEUE:${secId} (${advisor.first_name} ${advisor.last_name})`);
      } else {
        const payload = {
          sec_id: secId,
          first_name: advisor.first_name || "",
          last_name: advisor.last_name || "",
          firm_name: advisor.firm_name || "",
          city: advisor.city || "",
          state: advisor.state || "",
          crd: String(secId),
        };
        engineDb
          .prepare(
            `INSERT INTO enrichment_jobs (
               job_id, pipeline_id, entity_type, entity_id, payload_json,
               orchestrator_agent_id, message_prefix, status, queued_at
             ) VALUES (?, 'advisors', 'advisor', ?, ?, ?, 'ENRICH', 'queued', datetime('now'))`,
          )
          .run(newJobId(), entityId, JSON.stringify(payload), agentId);
        console.log(`QUEUED:${secId}`);
      }

      queued++;
      blocked.add(secId);
    }

    const summary = { queued, skipped, stopped };
    if (dryRun) summary.dry_run = true;
    console.log(`FEED_DONE:${JSON.stringify(summary)}`);
  } finally {
    db.close();
    engineDb.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
