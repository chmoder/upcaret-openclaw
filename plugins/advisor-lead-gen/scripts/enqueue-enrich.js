#!/usr/bin/env node
/**
 * enqueue-enrich.js — Queue one specific advisor for enrichment.
 *
 * Writes one enrichment_jobs row in enrichment.db for the given advisor.
 * This script does NOT send ENRICH directly.
 *
 * Usage:
 *   node scripts/enqueue-enrich.js --sec-id <SEC_ID>
 *
 * Output:
 *   QUEUED:<sec_id>               — job written to enrichment_jobs
 *   SKIP:<sec_id>:already_active  — already queued or running, do nothing
 *   ERROR:<message>               — advisor not found or DB error
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

function parseArgs(argv) {
  const args = argv.slice(2);
  let secId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sec-id" && args[i + 1]) {
      secId = parseInt(args[++i], 10);
    }
  }
  return { secId };
}

function main() {
  const { secId } = parseArgs(process.argv);

  if (!secId || !Number.isFinite(secId)) {
    console.error("ERROR: --sec-id <ID> is required");
    console.error("Usage: node scripts/enqueue-enrich.js --sec-id 4167394");
    process.exit(1);
  }

  const db = openDb();
  const engineDbPath = resolveEngineDbPath();
  const engineDb = openEngineDb(engineDbPath);
  try {
    initSchema(db);
    initEngineSchema(engineDb);
    ensureAdvisorPipeline(engineDb);

    const entityId = advisorEntityId(secId);
    const active = engineDb
      .prepare(
        `SELECT status
         FROM enrichment_jobs
         WHERE pipeline_id='advisors' AND entity_id=? AND status IN ('queued','running')
         ORDER BY queued_at DESC
         LIMIT 1`,
      )
      .get(entityId);
    if (active) {
      console.log(`SKIP:${secId}:already_active (status=${active.status})`);
      return;
    }

    const a = dbGet(
      db,
      `SELECT ap.sec_id, ap.first_name, ap.last_name, ap.firm_name, ap.city, ap.state
       FROM advisor_profiles ap
       WHERE ap.sec_id = ?`,
      [secId],
    );
    if (!a) {
      console.error(`ERROR: advisor sec_id=${secId} not found in DB`);
      process.exit(1);
    }

    const payload = {
      sec_id: Number(a.sec_id),
      first_name: a.first_name || "",
      last_name: a.last_name || "",
      firm_name: a.firm_name || "",
      city: a.city || "",
      state: a.state || "",
      crd: String(a.sec_id),
    };

    const agentId = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
    engineDb
      .prepare(
        `INSERT INTO enrichment_jobs (
          job_id, pipeline_id, entity_type, entity_id, payload_json,
          orchestrator_agent_id, message_prefix, status, queued_at
         ) VALUES (?, 'advisors', 'advisor', ?, ?, ?, 'ENRICH', 'queued', datetime('now'))`,
      )
      .run(newJobId(), entityId, JSON.stringify(payload), agentId);

    console.log(`QUEUED:${a.sec_id}`);
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
