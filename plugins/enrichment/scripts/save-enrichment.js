#!/usr/bin/env node

import fs from "node:fs";
import { dbRun, openDb } from "./db.js";
import { initSchema } from "./db-init.js";
import { normalizeFindingType } from "./finding-types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function readRawArg() {
  if (process.argv[2] === "--file") {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error("ERROR: --file requires a path");
      process.exit(1);
    }
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(`ERROR: cannot read file ${filePath} — ${err.message}`);
      process.exit(1);
    }
  }
  return process.argv[2];
}

function confidenceRank(confidence) {
  const normalized = String(confidence || "").trim().toLowerCase();
  if (normalized === "high") return 3;
  if (normalized === "medium") return 2;
  if (normalized === "low") return 1;
  return 0;
}

function pickBestFindingValue(findings, findingType) {
  let bestValue = "";
  let bestRank = -1;
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (normalizeFindingType(finding?.finding_type) !== findingType) continue;
    const value = String(finding?.finding_value || "").trim();
    if (!value) continue;
    const rank = confidenceRank(finding?.confidence);
    if (rank > bestRank) {
      bestValue = value;
      bestRank = rank;
    }
  }
  return bestValue;
}

function main() {
  const raw = readRawArg();
  if (!raw) {
    console.error("ERROR: no JSON argument provided");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: invalid JSON — ${err.message}`);
    process.exit(1);
  }

  const {
    profile_id: profileId,
    enrichment_score: enrichmentScore,
    score_reason: scoreReason,
    findings,
  } = payload;
  if (!profileId) {
    console.error("ERROR: profile_id is required (UUID)");
    process.exit(1);
  }
  if (!isUuid(profileId)) {
    console.error(`ERROR: profile_id must be a UUID. Received "${profileId}".`);
    process.exit(1);
  }

  const db = openDb();
  try {
    initSchema(db);
    const resolvedEmployer = pickBestFindingValue(findings, "current_employer");
    const resolvedTitle = pickBestFindingValue(findings, "current_title");

    const runningJob = db
      .prepare(
        `SELECT job_id
         FROM enrichment_jobs
         WHERE profile_id = ? AND status = 'running'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(String(profileId));
    if (!runningJob) {
      console.error(`ERROR:no active running job for profile_id ${profileId}`);
      process.exit(1);
    }

    dbRun(
      db,
      `UPDATE profiles
       SET enriched_at = datetime('now'),
           updated_at = datetime('now'),
           enrichment_score = ?,
           enrichment_score_reason = ?,
           enrichment_status = 'enriched',
           current_employer = CASE
             WHEN ? <> '' THEN ?
             ELSE current_employer
           END,
           current_title = CASE
             WHEN ? <> '' THEN ?
             ELSE current_title
           END
       WHERE profile_id = ?`,
      [
        Number(enrichmentScore) || 0,
        String(scoreReason || ""),
        resolvedEmployer,
        resolvedEmployer,
        resolvedTitle,
        resolvedTitle,
        String(profileId),
      ],
    );

    // Replace prior findings for this profile on each completed run.
    dbRun(db, `DELETE FROM findings WHERE profile_id = ?`, [String(profileId)]);

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO findings
       (profile_id, finding_type, finding_value, source_url, source_name, agent_name, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    let saved = 0;
    for (const f of Array.isArray(findings) ? findings : []) {
      const value = String(f.finding_value || "").trim();
      if (!value) continue;
      const result = insertStmt.run(
        String(profileId),
        normalizeFindingType(f.finding_type),
        value,
        String(f.source_url || ""),
        String(f.source_name || ""),
        String(f.agent_name || ""),
        String(f.confidence || "medium"),
      );
      saved += result.changes;
    }

    db.prepare(
      `UPDATE enrichment_jobs
       SET status='done', completed_at=datetime('now'), error=NULL, result_json=?
       WHERE job_id=?`,
    ).run(
      JSON.stringify({
        profile_id: String(profileId),
        enrichment_score: Number(enrichmentScore) || 0,
        score_reason: String(scoreReason || ""),
        findings_count: saved,
      }),
      String(runningJob.job_id),
    );

    db.prepare(
      `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
       VALUES (?, 'job_done', ?, NULL, datetime('now'))`,
    ).run(String(runningJob.job_id), `Saved enrichment for profile_id=${profileId}`);

    console.log(
      `SAVED:${JSON.stringify({
        profile_id: String(profileId),
        enrichment_score: Number(enrichmentScore) || 0,
        findings_count: saved,
      })}`,
    );
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
