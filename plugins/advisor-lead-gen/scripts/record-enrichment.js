#!/usr/bin/env node
/**
 * record-enrichment.js — Engine job/specialist state writes for advisor orchestrator.
 */

import {
  advisorEntityId,
  ensureAdvisorPipeline,
  initEngineSchema,
  newJobId,
  openEngineDb,
  resolveEngineDbPath,
  secIdFromEntityId,
} from "./engine-db.js";

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (
      a.startsWith("--") &&
      args[i + 1] !== undefined &&
      !args[i + 1].startsWith("--")
    ) {
      flags[a.slice(2)] = args[++i];
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = true;
    }
  }
  return { cmd, flags };
}

function getActiveJobForSecId(db, secId, statuses = ["queued", "running"]) {
  const placeholders = statuses.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT job_id, status
       FROM enrichment_jobs
       WHERE pipeline_id='advisors' AND entity_id=? AND status IN (${placeholders})
       ORDER BY queued_at DESC
       LIMIT 1`,
    )
    .get(advisorEntityId(secId), ...statuses);
  return row || null;
}

function main() {
  const { cmd, flags } = parseArgs(process.argv);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("Usage: node record-enrichment.js <subcommand> [flags]");
    console.log("Subcommands: queue-add, queue-start, queue-fail, queue-status,");
    console.log(
      "             specialist-start, specialist-list, specialist-done, specialist-fail,",
    );
    console.log("             log-error");
    process.exit(0);
  }

  const dbPath = resolveEngineDbPath();
  const db = openEngineDb(dbPath);
  try {
    initEngineSchema(db);
    ensureAdvisorPipeline(db);

    if (cmd === "queue-add") {
      const secId = Number(flags["sec-id"]);
      if (!secId) throw new Error("--sec-id required");
      const advisorJson = flags["advisor-json"] || null;

      const existing = getActiveJobForSecId(db, secId, ["queued", "running"]);
      if (existing) {
        console.log(`QUEUED:${secId} (already ${existing.status})`);
        return;
      }

      const agentId = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
      db.prepare(
        `INSERT INTO enrichment_jobs (
          job_id, pipeline_id, entity_type, entity_id, payload_json,
          orchestrator_agent_id, message_prefix, status, queued_at
         ) VALUES (?, 'advisors', 'advisor', ?, ?, ?, 'ENRICH', 'queued', datetime('now'))`,
      ).run(newJobId(), advisorEntityId(secId), String(advisorJson || "{}"), agentId);
      console.log(`QUEUED:${secId}`);
    } else if (cmd === "queue-start") {
      const secId = Number(flags["sec-id"]);
      if (!secId) throw new Error("--sec-id required");
      const alreadyRunning = db
        .prepare(
          `SELECT entity_id
           FROM enrichment_jobs
           WHERE status='running' AND pipeline_id='advisors' AND entity_id != ?
           LIMIT 1`,
        )
        .get(advisorEntityId(secId));
      if (alreadyRunning) {
        const otherSecId = secIdFromEntityId(alreadyRunning.entity_id);
        console.error(
          `ERROR:already_running:${otherSecId ?? alreadyRunning.entity_id} — cannot start ${secId} while another enrichment is active`,
        );
        process.exit(1);
      }
      const active = getActiveJobForSecId(db, secId, ["queued", "running"]);
      if (!active) {
        console.error(`ERROR:queue-start — no queued/running row found for sec_id ${secId}`);
        process.exit(1);
      }
      const startResult = db
        .prepare(
          `UPDATE enrichment_jobs
           SET status='running', started_at=datetime('now')
           WHERE job_id=?`,
        )
        .run(active.job_id);
      if (startResult.changes === 0) {
        console.error(`ERROR:queue-start — no queued/running row found for sec_id ${secId}`);
        process.exit(1);
      }
      console.log(`STARTED:${secId}`);
    } else if (cmd === "queue-fail") {
      const secId = Number(flags["sec-id"]);
      const error = flags["error"] || "unknown error";
      if (!secId) throw new Error("--sec-id required");
      const active = getActiveJobForSecId(db, secId, ["running"]);
      const failResult = active
        ? db
            .prepare(
              `UPDATE enrichment_jobs
               SET status='failed', completed_at=datetime('now'), error=?
               WHERE job_id=?`,
            )
            .run(error, active.job_id)
        : { changes: 0 };
      if (failResult.changes === 0) {
        console.error(`ERROR:queue-fail — no running row found for sec_id ${secId}`);
        process.exit(1);
      }
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_failed', ?, NULL, datetime('now'))`,
      ).run(active.job_id, String(error));
      console.log(`FAILED:${secId}`);
    } else if (cmd === "queue-status") {
      const row = db
        .prepare(
          `SELECT entity_id
           FROM enrichment_jobs
           WHERE pipeline_id='advisors' AND status='running'
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get();
      if (!row) {
        console.log("IDLE");
      } else {
        const secId = secIdFromEntityId(row.entity_id);
        console.log(secId ? `RUNNING:${secId}` : "IDLE");
      }
    } else if (cmd === "specialist-start") {
      const secId = Number(flags["sec-id"]);
      const specialist = flags["specialist"];
      const sessionKey = flags["session-key"] || "";
      if (!secId || !specialist)
        throw new Error("--sec-id and --specialist required");
      const active = getActiveJobForSecId(db, secId, ["running"]);
      if (!active) {
        throw new Error(`no running job for sec_id=${secId}`);
      }
      db.prepare(
        `INSERT OR REPLACE INTO enrichment_specialist_runs
           (job_id, specialist_name, child_session_key, status, spawned_at)
         VALUES (?, ?, ?, 'PENDING', datetime('now'))`,
      ).run(active.job_id, specialist, sessionKey);
      console.log(`SPECIALIST_STARTED:${secId}:${specialist}`);
    } else if (cmd === "specialist-list") {
      const secId = Number(flags["sec-id"]);
      if (!secId) throw new Error("--sec-id required");
      const statusFilter = flags["status"] || null;
      const active = getActiveJobForSecId(db, secId, ["running"]);
      if (!active) {
        console.log("NONE");
        return;
      }
      const sql = statusFilter
        ? `SELECT specialist_name, child_session_key, status, spawned_at
           FROM enrichment_specialist_runs WHERE job_id=? AND status=? ORDER BY specialist_name`
        : `SELECT specialist_name, child_session_key, status, spawned_at
           FROM enrichment_specialist_runs WHERE job_id=? ORDER BY specialist_name`;
      const params = statusFilter ? [active.job_id, statusFilter] : [active.job_id];
      const rows = db.prepare(sql).all(...params);
      const now = Date.now();
      for (const r of rows) {
        const spawned = r.spawned_at
          ? new Date(r.spawned_at.includes("T") ? r.spawned_at : r.spawned_at.replace(" ", "T") + "Z").getTime()
          : now;
        const elapsedSecs = Math.floor((now - spawned) / 1000);
        console.log(`${r.status}:${r.specialist_name}:${r.child_session_key}:${elapsedSecs}`);
      }
      if (rows.length === 0) console.log("NONE");
    } else if (cmd === "specialist-done") {
      const secId = Number(flags["sec-id"]);
      const specialist = flags["specialist"];
      if (!secId || !specialist)
        throw new Error("--sec-id and --specialist required");
      const active = getActiveJobForSecId(db, secId, ["running"]);
      if (!active) {
        throw new Error(`no running job for sec_id=${secId}`);
      }
      db.prepare(
        `UPDATE enrichment_specialist_runs SET status='DONE', completed_at=datetime('now')
         WHERE job_id=? AND specialist_name=?`,
      ).run(active.job_id, specialist);
      console.log(`SPECIALIST_DONE:${secId}:${specialist}`);
    } else if (cmd === "specialist-fail") {
      const secId = Number(flags["sec-id"]);
      const specialist = flags["specialist"];
      const error = flags["error"] || "timeout or no response";
      if (!secId || !specialist)
        throw new Error("--sec-id and --specialist required");
      const active = getActiveJobForSecId(db, secId, ["running"]);
      if (!active) {
        throw new Error(`no running job for sec_id=${secId}`);
      }
      db.prepare(
        `UPDATE enrichment_specialist_runs SET status='FAILED', completed_at=datetime('now'), error=?
         WHERE job_id=? AND specialist_name=?`,
      ).run(error, active.job_id, specialist);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'specialist_failed', ?, ?, datetime('now'))`,
      ).run(
        active.job_id,
        String(error),
        JSON.stringify({ sec_id: secId, specialist }),
      );
      console.log(`SPECIALIST_FAILED:${secId}:${specialist}`);
    } else if (cmd === "log-error") {
      const secId = flags["sec-id"] ? Number(flags["sec-id"]) : null;
      const specialist = flags["specialist"] || null;
      const errorType = flags["error-type"] || "unknown";
      const message = flags["message"] || "";
      const context = flags["context"] || null;
      let jobId = null;
      if (secId) {
        const active = getActiveJobForSecId(db, secId, ["running", "queued", "failed", "done"]);
        jobId = active?.job_id || null;
      }
      const composedContext = JSON.stringify({
        specialist,
        context: context || null,
      });
      const res = db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(jobId, errorType, message, composedContext);
      console.log(`ERROR_LOGGED:${res.lastInsertRowid || 0}`);
    } else {
      throw new Error(`Unknown subcommand: ${cmd}`);
    }
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
