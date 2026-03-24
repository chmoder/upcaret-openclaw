#!/usr/bin/env node

/**
 * save-enrichment.js — Write enrichment results to advisors.db
 *
 * Used by the advisor-enrich orchestrator agent (LLM path) to persist
 * specialist findings + scorer output without needing the sqlite3 CLI.
 *
 * Usage:
 *   node scripts/save-enrichment.js '<json>'
 *
 * JSON input shape:
 *   {
 *     "sec_id": 4167394,
 *     "lead_score": 4,
 *     "score_reason": "...",
 *     "findings": [
 *       { "finding_type": "email", "finding_value": "foo@bar.com", "source_url": "", "confidence": "high" },
 *       ...
 *     ]
 *   }
 *
 * On success, prints:  SAVED:{"sec_id":...,"lead_score":...,"findings_count":...}
 * On error, prints:    ERROR:<message>  and exits with code 1.
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import fs from "node:fs";

import { dbGet, dbRun, openDb, resolveDomainDbPath } from "./db.js";
import {
  advisorEntityId,
  initEngineSchema,
  openEngineDb,
  resolveEngineDbPath,
} from "./engine-db.js";
import { normalizeFindingType } from "./finding-types.js";

const DB_PATH = resolveDomainDbPath();
const ENGINE_DB_PATH = resolveEngineDbPath();

function main() {
  // Accept either:
  //   node save-enrichment.js <json-string>
  //   node save-enrichment.js --file <path-to-json-file>
  let raw;
  if (process.argv[2] === '--file') {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error('ERROR: --file requires a path');
      process.exit(1);
    }
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(`ERROR: cannot read file ${filePath} — ${err.message}`);
      process.exit(1);
    }
  } else {
    raw = process.argv[2];
  }

  if (!raw) {
    console.error('ERROR: no JSON argument provided');
    console.error('Usage:');
    console.error('  node scripts/save-enrichment.js \'{"sec_id":...}\'');
    console.error('  node scripts/save-enrichment.js --file /path/to/result.json');
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: invalid JSON — ${err.message}`);
    process.exit(1);
  }

  const { sec_id, lead_score, score_reason, findings } = payload;

  if (!sec_id) {
    console.error('ERROR: sec_id is required');
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  const engineDb = openEngineDb(ENGINE_DB_PATH);
  try {
    initEngineSchema(engineDb);
    const entityId = advisorEntityId(sec_id);

    // Ensure the entity exists so findings inserts don't trip the FK constraint
    // when the domain DB was created but not yet populated with advisor entities.
    dbRun(
      db,
      `INSERT OR IGNORE INTO entities (entity_id, entity_type, source_system, source_key, created_at, updated_at)
       VALUES (?, 'advisor', 'sec_iapd', ?, datetime('now'), datetime('now'))`,
      [entityId, String(sec_id)],
    );
    const profileExists = dbGet(
      db,
      `SELECT 1 AS ok FROM advisor_profiles WHERE sec_id = ? LIMIT 1`,
      [Number(sec_id)],
    );
    if (!profileExists) {
      console.error(
        `WARN: advisor_profiles row missing for sec_id ${sec_id} in ${DB_PATH} (save will continue)`,
      );
    }

    // Guard: only accept results for an actively running engine job.
    const runningJob = engineDb
      .prepare(
        `SELECT job_id
         FROM enrichment_jobs
         WHERE pipeline_id='advisors' AND entity_id=? AND status='running'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(entityId);
    if (!runningJob) {
      console.error(
        `ERROR:no active running job for sec_id ${sec_id} — result discarded (advisor may have timed out or already completed)`,
      );
      process.exit(1);
    }

    // Update domain entity summary.
    dbRun(
      db,
      `UPDATE entities
       SET enriched_at       = datetime('now'),
           updated_at        = datetime('now'),
           lead_score        = ?,
           lead_score_reason = ?,
           validation_status = CASE
             WHEN validation_status IS NULL OR validation_status = 'pending'
             THEN 'enriched'
             ELSE validation_status
           END
       WHERE entity_id = ?`,
      [Number(lead_score) || 0, String(score_reason || ""), entityId],
    );

    // Insert findings into the unified findings table.
    const insertSql = `
      INSERT OR IGNORE INTO findings
        (entity_id, finding_type, finding_value, source_url, agent_name, confidence, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, datetime('now'))
    `;

    const insertStmt = db.prepare(insertSql);
    let saved = 0;
    const coercedTypeCounts = new Map();
    for (const f of Array.isArray(findings) ? findings : []) {
      const value = String(f.finding_value || '').trim();
      if (!value) continue;
      const rawType = String(f.finding_type ?? "").trim();
      const findingType = normalizeFindingType(rawType);
      if (findingType === "unknown" && rawType.toLowerCase() !== "unknown") {
        const key = rawType || "(empty)";
        coercedTypeCounts.set(key, (coercedTypeCounts.get(key) || 0) + 1);
      }
      const r = insertStmt.run(
        entityId,
        findingType,
        value,
        String(f.source_url || ''),
        String(f.agent_name || f.source_name || ''),
        String(f.confidence || 'medium'),
      );
      saved += r.changes; // 0 if deduped by UNIQUE constraint, 1 if inserted
    }
    if (coercedTypeCounts.size > 0) {
      const summary = Array.from(coercedTypeCounts.entries())
        .map(([type, count]) => `${type} (${count})`)
        .join(", ");
      console.error(`WARN: coerced invalid finding_type values to "unknown": ${summary}`);
    }

    engineDb
      .prepare(
        `UPDATE enrichment_jobs
         SET status='done',
             completed_at=datetime('now'),
             result_json=?,
             error=NULL
         WHERE job_id=?`,
      )
      .run(
        JSON.stringify({
          sec_id,
          lead_score: Number(lead_score) || 0,
          score_reason: String(score_reason || ""),
          findings_count: saved,
        }),
        String(runningJob.job_id),
      );

    engineDb
      .prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_done', ?, NULL, datetime('now'))`,
      )
      .run(String(runningJob.job_id), `Saved enrichment for sec_id=${sec_id}`);

    const result = { sec_id, lead_score: Number(lead_score) || 0, findings_count: saved };
    console.log(`SAVED:${JSON.stringify(result)}`);
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
