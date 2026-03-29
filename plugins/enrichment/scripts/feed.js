#!/usr/bin/env node

import { dbGet, newJobId, openDb } from "./db.js";
import { initSchema } from "./db-init.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD_DAYS = 90;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = argv.slice(2);
  let limit = DEFAULT_LIMIT;
  let thresholdDays = DEFAULT_THRESHOLD_DAYS;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
    } else if (args[i] === "--threshold-days" && args[i + 1]) {
      thresholdDays = Number.parseInt(args[++i], 10);
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { limit, thresholdDays, dryRun };
}

function pickNext(db, thresholdDays, blockedSet) {
  const blocked = [...blockedSet];
  const blockedClause =
    blocked.length > 0
      ? `AND p.profile_id NOT IN (${blocked.map(() => "?").join(", ")})`
      : "";

  const neverEnriched = dbGet(
    db,
    `SELECT profile_id, first_name, last_name, display_name, current_employer, current_title,
            location_city, location_state
     FROM profiles p
     WHERE p.enriched_at IS NULL
       ${blockedClause}
     ORDER BY p.created_at ASC
     LIMIT 1`,
    blocked,
  );
  if (neverEnriched) return neverEnriched;

  return dbGet(
    db,
    `SELECT profile_id, first_name, last_name, display_name, current_employer, current_title,
            location_city, location_state
     FROM profiles p
     WHERE p.enriched_at IS NOT NULL
       AND datetime(p.enriched_at) < datetime('now', '-${thresholdDays} days')
       ${blockedClause}
     ORDER BY p.enriched_at ASC
     LIMIT 1`,
    blocked,
  );
}

function main() {
  const { limit, thresholdDays, dryRun } = parseArgs(process.argv);
  if (!Number.isFinite(limit) || limit < 1) {
    console.error("ERROR: --limit must be a positive integer");
    process.exit(1);
  }
  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) {
    console.error("ERROR: --threshold-days must be a positive integer");
    process.exit(1);
  }

  const db = openDb();
  try {
    initSchema(db);

    const blocked = new Set(
      db
        .prepare(
          `SELECT profile_id
           FROM enrichment_jobs
           WHERE status IN ('queued', 'running')`,
        )
        .all()
        .map((r) => String(r.profile_id || "").trim())
        .filter(Boolean),
    );

    const agentId = process.env.ENRICH_ORCH_AGENT_ID || "profile-enrich";
    const workspace =
      process.env.ENRICHMENT_WORKSPACE || path.join(__dirname, "..");

    let queued = 0;
    let skipped = 0;
    let stopped = "limit_reached";

    for (let i = 0; i < limit; i++) {
      const profile = pickNext(db, thresholdDays, blocked);
      if (!profile) {
        stopped = "no_more_due";
        break;
      }

      const active = dbGet(
        db,
        `SELECT status
         FROM enrichment_jobs
         WHERE profile_id = ? AND status IN ('queued', 'running')
         LIMIT 1`,
        [profile.profile_id],
      );
      if (active) {
        skipped++;
        blocked.add(profile.profile_id);
        console.log(`SKIP:${profile.profile_id}:already_active`);
        continue;
      }

      if (dryRun) {
        console.log(`WOULD_QUEUE:${profile.profile_id}`);
      } else {
        const payload = {
          profile_id: profile.profile_id,
          first_name: profile.first_name || "",
          last_name: profile.last_name || "",
          display_name: profile.display_name || "",
          current_employer: profile.current_employer || "",
          current_title: profile.current_title || "",
          location_city: profile.location_city || "",
          location_state: profile.location_state || "",
        };
        db.prepare(
          `INSERT INTO enrichment_jobs (
             job_id, profile_id, payload_json, orchestrator_agent_id, orchestrator_workspace,
             message_prefix, status, priority, queued_at
           ) VALUES (?, ?, ?, ?, ?, 'ENRICH', 'queued', 0, datetime('now'))`,
        ).run(
          newJobId(),
          profile.profile_id,
          JSON.stringify(payload),
          agentId,
          workspace,
        );
        console.log(`QUEUED:${profile.profile_id}`);
      }

      blocked.add(profile.profile_id);
      queued++;
    }

    const summary = { queued, skipped, stopped, dry_run: dryRun };
    console.log(`FEED_DONE:${JSON.stringify(summary)}`);
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
