#!/usr/bin/env node
/**
 * next-advisor.js — Find the next advisor due for enrichment.
 *
 * Queries advisors.db and returns the single best candidate to enrich next:
 *   1. Never enriched (enriched_at IS NULL) — highest priority
 *   2. Stale — enriched_at older than ENRICH_THRESHOLD_DAYS (default: 90)
 *
 * Excludes advisors currently queued or running in enrichment_jobs (engine DB).
 *
 * Designed to feed the dispatch loop:
 *   node scripts/next-advisor.js
 *   → NEXT:4167394
 *   → NONE:no_advisors_due
 *
 * Usage:
 *   node scripts/next-advisor.js
 *   node scripts/next-advisor.js --threshold-days 60
 *   node scripts/next-advisor.js --state NE
 *   node scripts/next-advisor.js --state NE --threshold-days 30
 *
 * Flags:
 *   --threshold-days N   Days before a completed enrichment is considered stale (default: 90)
 *   --state XX           Filter to advisors in this US state (e.g. NE, CA)
 *
 * Output:
 *   NEXT:<sec_id>          — one advisor is due; dispatch this sec_id next
 *   NONE:no_advisors_due   — all advisors are current; nothing to do
 *   ERROR:<message>        — unexpected failure (exits 1)
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import { dbGet, openDb } from "./db.js";
import { initSchema } from "./db-init.js";
import { initEngineSchema, openEngineDb, resolveEngineDbPath } from "./engine-db.js";

const DEFAULT_THRESHOLD_DAYS = 90;

function parseArgs(argv) {
  const args = argv.slice(2);
  let thresholdDays = DEFAULT_THRESHOLD_DAYS;
  let state = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold-days' && args[i + 1]) {
      thresholdDays = parseInt(args[++i], 10);
    } else if (args[i] === '--state' && args[i + 1]) {
      state = args[++i].toUpperCase();
    }
  }
  return { thresholdDays, state };
}

function main() {
  const { thresholdDays, state } = parseArgs(process.argv);

  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) {
    console.error('ERROR: --threshold-days must be a positive integer');
    process.exit(1);
  }

  const db = openDb();
  const engineDb = openEngineDb(resolveEngineDbPath());
  try {
    initSchema(db);
    initEngineSchema(engineDb);

    const stateFilter = state ? `AND ap.state = '${state.replace(/'/g, "''")}'` : "";
    const blockedSecIds = engineDb
      .prepare(
        `SELECT entity_id
         FROM enrichment_jobs
         WHERE pipeline_id='advisors' AND status IN ('queued', 'running')`,
      )
      .all()
      .map((r) => Number(String(r.entity_id || "").replace(/^advisor:/, "")))
      .filter((n) => Number.isFinite(n));

    const blocked = new Set(
      blockedSecIds,
    );

    const blockedClause =
      blockedSecIds.length > 0
        ? `AND ap.sec_id NOT IN (${blockedSecIds.map(() => "?").join(", ")})`
        : "";

    // Priority 1: never enriched.
    const neverEnriched = dbGet(
      db,
      `
      SELECT ap.sec_id, ap.first_name, ap.last_name
      FROM advisor_profiles ap
      JOIN entities e ON e.entity_id = ap.entity_id
      WHERE e.enriched_at IS NULL
        ${stateFilter}
        ${blockedClause}
      ORDER BY ap.sec_id ASC
      LIMIT 1
      `,
      blockedSecIds,
    );
    if (neverEnriched) {
      console.log(`NEXT:${neverEnriched.sec_id}`);
      return;
    }

    // Priority 2: stale (enriched_at older than threshold).
    const stale = dbGet(
      db,
      `
      SELECT ap.sec_id
      FROM advisor_profiles ap
      JOIN entities e ON e.entity_id = ap.entity_id
      WHERE e.enriched_at IS NOT NULL
        ${stateFilter}
        AND datetime(e.enriched_at) < datetime('now', '-${thresholdDays} days')
        ${blockedClause}
      ORDER BY e.enriched_at ASC
      LIMIT 1
      `,
      blockedSecIds,
    );
    if (stale) {
      console.log(`NEXT:${stale.sec_id}`);
      return;
    }

    console.log("NONE:no_advisors_due");
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
