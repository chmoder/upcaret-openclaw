#!/usr/bin/env node

import { dbGet, openDb } from "./db.js";
import { initSchema } from "./db-init.js";

const DEFAULT_THRESHOLD_DAYS = 90;

function parseArgs(argv) {
  const args = argv.slice(2);
  let thresholdDays = DEFAULT_THRESHOLD_DAYS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold-days" && args[i + 1]) {
      thresholdDays = Number.parseInt(args[++i], 10);
    }
  }
  return { thresholdDays };
}

function main() {
  const { thresholdDays } = parseArgs(process.argv);
  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) {
    console.error("ERROR: --threshold-days must be a positive integer");
    process.exit(1);
  }

  const db = openDb();
  try {
    initSchema(db);

    const blocked = db
      .prepare(
        `SELECT profile_id
         FROM enrichment_jobs
         WHERE status IN ('queued', 'running')`,
      )
      .all()
      .map((r) => String(r.profile_id || "").trim())
      .filter(Boolean);

    const blockedClause =
      blocked.length > 0
        ? `AND p.profile_id NOT IN (${blocked.map(() => "?").join(", ")})`
        : "";

    const never = dbGet(
      db,
      `SELECT p.profile_id
       FROM profiles p
       WHERE p.enriched_at IS NULL
         ${blockedClause}
       ORDER BY p.created_at ASC
       LIMIT 1`,
      blocked,
    );
    if (never) {
      console.log(`NEXT:${never.profile_id}`);
      return;
    }

    const stale = dbGet(
      db,
      `SELECT p.profile_id
       FROM profiles p
       WHERE p.enriched_at IS NOT NULL
         AND datetime(p.enriched_at) < datetime('now', '-${thresholdDays} days')
         ${blockedClause}
       ORDER BY p.enriched_at ASC
       LIMIT 1`,
      blocked,
    );
    if (stale) {
      console.log(`NEXT:${stale.profile_id}`);
      return;
    }

    console.log("NONE:no_profiles_due");
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
