#!/usr/bin/env node
/**
 * next-advisor.js — Find the next advisor due for enrichment.
 *
 * Queries advisors.db and returns the single best candidate to enrich next:
 *   1. Never enriched (enriched_at IS NULL) — highest priority
 *   2. Data changed since last enrichment (data_hash mismatch)
 *   3. Stale — enriched_at older than ENRICH_THRESHOLD_DAYS (default: 90)
 *
 * Excludes advisors currently queued or running in enrichment_queue.
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

'use strict';

const path = require('path');
const { openDb, dbGet, computeAdvisorHash } = require('./db');
const { initSchema } = require('./db-init');

const DB_PATH = path.join(__dirname, '..', 'advisors.db');
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

  const db = openDb(DB_PATH);
  try {
    initSchema(db);

    const stateFilter = state ? `AND a.state = '${state.replace(/'/g, "''")}'` : '';

    // Subquery: sec_ids currently blocked (queued or running).
    const blockedSub = `
      SELECT sec_id FROM enrichment_queue
      WHERE status IN ('queued', 'running')
    `;

    // Priority 1: never enriched.
    const neverEnriched = dbGet(db, `
      SELECT a.sec_id, a.first_name, a.last_name, a.data_hash
      FROM advisors a
      WHERE a.enriched_at IS NULL
        ${stateFilter}
        AND a.sec_id NOT IN (${blockedSub})
      ORDER BY a.sec_id ASC
      LIMIT 1
    `);
    if (neverEnriched) {
      console.log(`NEXT:${neverEnriched.sec_id}`);
      return;
    }

    // Priority 2: data changed since last enrichment (hash mismatch).
    // We compare the stored data_hash to a recomputed one for each row,
    // but SQLite can't call JS functions — so we load all candidates and
    // filter in JS. Cap at 500 rows to stay fast.
    const hashCandidates = db.prepare(`
      SELECT a.sec_id, a.first_name, a.last_name, a.firm_name,
             a.city, a.state, a.data_hash, a.enriched_at
      FROM advisors a
      WHERE a.enriched_at IS NOT NULL
        ${stateFilter}
        AND a.sec_id NOT IN (${blockedSub})
      ORDER BY a.enriched_at ASC
      LIMIT 500
    `).all();

    for (const a of hashCandidates) {
      const current = computeAdvisorHash(a);
      if (current !== a.data_hash) {
        console.log(`NEXT:${a.sec_id}`);
        return;
      }
    }

    // Priority 3: stale (enriched_at older than threshold).
    const stale = dbGet(db, `
      SELECT a.sec_id
      FROM advisors a
      WHERE a.enriched_at IS NOT NULL
        ${stateFilter}
        AND a.sec_id NOT IN (${blockedSub})
        AND datetime(a.enriched_at) < datetime('now', '-${thresholdDays} days')
      ORDER BY a.enriched_at ASC
      LIMIT 1
    `);
    if (stale) {
      console.log(`NEXT:${stale.sec_id}`);
      return;
    }

    console.log('NONE:no_advisors_due');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
