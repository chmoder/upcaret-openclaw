#!/usr/bin/env node

import { dbGet, newJobId, openDb } from "./db.js";
import { initSchema } from "./db-init.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      flags[a.slice(2)] = args[++i];
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = true;
    }
  }
  return { cmd, flags };
}

function getActiveJobForProfile(db, profileId, statuses = ["queued", "running"]) {
  const placeholders = statuses.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT job_id, status
         FROM enrichment_jobs
         WHERE profile_id = ? AND status IN (${placeholders})
         ORDER BY queued_at DESC
         LIMIT 1`,
      )
      .get(profileId, ...statuses) || null
  );
}

function main() {
  const { cmd, flags } = parseArgs(process.argv);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("Usage: node record-enrichment.js <subcommand> [flags]");
    console.log(
      "Subcommands: queue-add, queue-start, queue-fail, queue-status, specialist-start, specialist-list, specialist-done, specialist-fail, log-error",
    );
    process.exit(0);
  }

  const db = openDb();
  try {
    initSchema(db);

    if (cmd === "queue-add") {
      const profileId = String(flags["profile-id"] || "").trim();
      if (!profileId) throw new Error("--profile-id required");
      const payload = flags["profile-json"] || "{}";

      const existing = getActiveJobForProfile(db, profileId, ["queued", "running"]);
      if (existing) {
        console.log(`QUEUED:${profileId} (already ${existing.status})`);
        return;
      }

      const agentId = process.env.ENRICH_ORCH_AGENT_ID || "profile-enrich";
      const workspace =
        process.env.ENRICHMENT_WORKSPACE || path.join(__dirname, "..");
      db.prepare(
        `INSERT INTO enrichment_jobs (
           job_id, profile_id, payload_json, orchestrator_agent_id, orchestrator_workspace,
           message_prefix, status, queued_at
         ) VALUES (?, ?, ?, ?, ?, 'ENRICH', 'queued', datetime('now'))`,
      ).run(newJobId(), profileId, payload, agentId, workspace);
      console.log(`QUEUED:${profileId}`);
      return;
    }

    if (cmd === "queue-start") {
      const profileId = String(flags["profile-id"] || "").trim();
      if (!profileId) throw new Error("--profile-id required");

      const alreadyRunning = db
        .prepare(
          `SELECT profile_id
           FROM enrichment_jobs
           WHERE status='running' AND profile_id != ?
           LIMIT 1`,
        )
        .get(profileId);
      if (alreadyRunning) {
        console.error(`ERROR:another_running:${alreadyRunning.profile_id}`);
        process.exit(1);
      }

      const active = getActiveJobForProfile(db, profileId, ["queued", "running"]);
      if (!active) {
        console.error(`ERROR:queue-start — no queued/running row found for ${profileId}`);
        process.exit(1);
      }

      db.prepare(
        `UPDATE enrichment_jobs
         SET status='running', started_at=datetime('now')
         WHERE job_id=?`,
      ).run(active.job_id);
      console.log(`STARTED:${profileId}`);
      return;
    }

    if (cmd === "queue-fail") {
      const profileId = String(flags["profile-id"] || "").trim();
      const error = String(flags["error"] || "unknown error");
      if (!profileId) throw new Error("--profile-id required");
      const active = getActiveJobForProfile(db, profileId, ["running"]);
      if (!active) {
        console.error(`ERROR:queue-fail — no running row found for ${profileId}`);
        process.exit(1);
      }
      db.prepare(
        `UPDATE enrichment_jobs
         SET status='failed', completed_at=datetime('now'), error=?
         WHERE job_id=?`,
      ).run(error, active.job_id);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_failed', ?, NULL, datetime('now'))`,
      ).run(active.job_id, error);
      console.log(`FAILED:${profileId}`);
      return;
    }

    if (cmd === "queue-status") {
      const row = db
        .prepare(
          `SELECT profile_id
           FROM enrichment_jobs
           WHERE status='running'
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get();
      if (!row) console.log("IDLE");
      else console.log(`RUNNING:${row.profile_id}`);
      return;
    }

    if (cmd === "specialist-start") {
      const profileId = String(flags["profile-id"] || "").trim();
      const specialist = String(flags["specialist"] || "").trim();
      const sessionKey = String(flags["session-key"] || "");
      if (!profileId || !specialist) throw new Error("--profile-id and --specialist required");
      const active = getActiveJobForProfile(db, profileId, ["running"]);
      if (!active) throw new Error(`no running job for profile_id=${profileId}`);
      db.prepare(
        `INSERT OR REPLACE INTO enrichment_specialist_runs
           (job_id, specialist_name, child_session_key, status, spawned_at)
         VALUES (?, ?, ?, 'PENDING', datetime('now'))`,
      ).run(active.job_id, specialist, sessionKey);
      console.log(`SPECIALIST_STARTED:${profileId}:${specialist}`);
      return;
    }

    if (cmd === "specialist-list") {
      const profileId = String(flags["profile-id"] || "").trim();
      if (!profileId) throw new Error("--profile-id required");
      const statusFilter = flags["status"] ? String(flags["status"]) : null;
      const active = getActiveJobForProfile(db, profileId, ["running"]);
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
          ? new Date(
              String(r.spawned_at).includes("T")
                ? String(r.spawned_at)
                : `${String(r.spawned_at).replace(" ", "T")}Z`,
            ).getTime()
          : now;
        const elapsedSecs = Math.floor((now - spawned) / 1000);
        console.log(`${r.status}:${r.specialist_name}:${r.child_session_key}:${elapsedSecs}`);
      }
      if (rows.length === 0) console.log("NONE");
      return;
    }

    if (cmd === "specialist-done") {
      const profileId = String(flags["profile-id"] || "").trim();
      const specialist = String(flags["specialist"] || "").trim();
      if (!profileId || !specialist) throw new Error("--profile-id and --specialist required");
      const active = getActiveJobForProfile(db, profileId, ["running"]);
      if (!active) throw new Error(`no running job for profile_id=${profileId}`);
      db.prepare(
        `UPDATE enrichment_specialist_runs
         SET status='DONE', completed_at=datetime('now')
         WHERE job_id=? AND specialist_name=?`,
      ).run(active.job_id, specialist);
      console.log(`SPECIALIST_DONE:${profileId}:${specialist}`);
      return;
    }

    if (cmd === "specialist-fail") {
      const profileId = String(flags["profile-id"] || "").trim();
      const specialist = String(flags["specialist"] || "").trim();
      const error = String(flags["error"] || "timeout or no response");
      if (!profileId || !specialist) throw new Error("--profile-id and --specialist required");
      const active = getActiveJobForProfile(db, profileId, ["running"]);
      if (!active) throw new Error(`no running job for profile_id=${profileId}`);
      db.prepare(
        `UPDATE enrichment_specialist_runs
         SET status='FAILED', completed_at=datetime('now'), error=?
         WHERE job_id=? AND specialist_name=?`,
      ).run(error, active.job_id, specialist);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'specialist_failed', ?, ?, datetime('now'))`,
      ).run(active.job_id, error, JSON.stringify({ profile_id: profileId, specialist }));
      console.log(`SPECIALIST_FAILED:${profileId}:${specialist}`);
      return;
    }

    if (cmd === "log-error") {
      const profileId = String(flags["profile-id"] || "").trim();
      const specialist = flags["specialist"] ? String(flags["specialist"]) : null;
      const errorType = String(flags["error-type"] || "unknown");
      const message = String(flags["message"] || "");
      const context = flags["context"] ? String(flags["context"]) : null;
      let jobId = null;
      if (profileId) {
        const active = getActiveJobForProfile(db, profileId, [
          "running",
          "queued",
          "failed",
          "done",
        ]);
        jobId = active?.job_id || null;
      }
      const res = db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(
        jobId,
        errorType,
        message,
        JSON.stringify({ specialist, context }),
      );
      console.log(`ERROR_LOGGED:${res.lastInsertRowid || 0}`);
      return;
    }

    throw new Error(`Unknown subcommand: ${cmd}`);
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
