#!/usr/bin/env node
/**
 * record-enrichment.js — Orchestration state writes for the advisor-enrich agent.
 *
 * Called by the orchestrator LLM (via exec) and by the main agent when dispatching.
 * Centralises all writes to enrichment_queue, pending_enrichments, and enrichment_errors
 * so the orchestrator's IDENTITY.md can stay concise.
 *
 * Subcommands:
 *
 *   queue-add --sec-id <N> --advisor-json '<json>'
 *     Insert a new queued row (idempotent — skips if already queued/running).
 *     Output: QUEUED:<sec_id>
 *
 *   queue-start --sec-id <N>
 *     Mark queue row as running. Output: STARTED:<sec_id>
 *
 *   queue-fail --sec-id <N> --error '<msg>'
 *     Mark queue row as failed. Output: FAILED:<sec_id>
 *
 *   queue-status
 *     Print the currently running enrichment, or IDLE if none.
 *     Output: RUNNING:<sec_id>  or  IDLE
 *
 *   specialist-start --sec-id <N> --specialist <name> --session-key <key>
 *     Insert pending_enrichments row for a specialist. Output: SPECIALIST_STARTED:<sec_id>:<name>
 *
 *   specialist-list --sec-id <N> [--status PENDING|DONE|FAILED]
 *     List specialists for an advisor, one per line.
 *     Output: <STATUS>:<name>:<childSessionKey>:<elapsed_secs>
 *
 *   specialist-done --sec-id <N> --specialist <name>
 *     Mark specialist as DONE. Output: SPECIALIST_DONE:<sec_id>:<name>
 *
 *   specialist-fail --sec-id <N> --specialist <name> --error '<msg>'
 *     Mark specialist as FAILED and log error. Output: SPECIALIST_FAILED:<sec_id>:<name>
 *
 *   log-error --sec-id <N> [--specialist <name>] --error-type <type> --message '<msg>' [--context '<json>']
 *     Append to enrichment_errors log. Output: ERROR_LOGGED:<id>
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

"use strict";

const path = require("path");
const { openDb, dbRun, dbGet, dbAll } = require("./db");
const { initSchema } = require("./db-init");

const DB_PATH = path.join(__dirname, "..", "advisors.db");

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

  const db = openDb(DB_PATH);
  try {
    initSchema(db);

    if (cmd === "queue-add") {
      const secId = Number(flags["sec-id"]);
      if (!secId) throw new Error("--sec-id required");
      const advisorJson = flags["advisor-json"] || null;

      // Skip if already in queue with a non-terminal status
      const existing = dbGet(
        db,
        `SELECT id, status FROM enrichment_queue WHERE sec_id = ? AND status IN ('queued','running') LIMIT 1`,
        [secId],
      );
      if (existing) {
        console.log(`QUEUED:${secId} (already ${existing.status})`);
        return;
      }

      db.prepare(
        `INSERT INTO enrichment_queue (sec_id, advisor_json, status, queued_at)
         VALUES (?, ?, 'queued', datetime('now'))`,
      ).run(secId, advisorJson);
      console.log(`QUEUED:${secId}`);
    } else if (cmd === "queue-start") {
      const secId = Number(flags["sec-id"]);
      if (!secId) throw new Error("--sec-id required");
      // Enforce single-running: reject if a *different* sec_id is already running.
      const alreadyRunning = dbGet(
        db,
        `SELECT sec_id FROM enrichment_queue WHERE status='running' AND sec_id != ? LIMIT 1`,
        [secId],
      );
      if (alreadyRunning) {
        console.error(`ERROR:already_running:${alreadyRunning.sec_id} — cannot start ${secId} while another enrichment is active`);
        process.exit(1);
      }
      const startResult = db.prepare(
        `UPDATE enrichment_queue SET status='running', started_at=datetime('now')
         WHERE id = (SELECT id FROM enrichment_queue WHERE sec_id=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1)`,
      ).run(secId);
      if (startResult.changes === 0) {
        console.error(`ERROR:queue-start — no queued/running row found for sec_id ${secId}`);
        process.exit(1);
      }
      console.log(`STARTED:${secId}`);
    } else if (cmd === "queue-fail") {
      const secId = Number(flags["sec-id"]);
      const error = flags["error"] || "unknown error";
      if (!secId) throw new Error("--sec-id required");
      const failResult = db.prepare(
        `UPDATE enrichment_queue SET status='failed', completed_at=datetime('now'), error=?
         WHERE id = (SELECT id FROM enrichment_queue WHERE sec_id=? AND status='running' ORDER BY id DESC LIMIT 1)`,
      ).run(error, secId);
      if (failResult.changes === 0) {
        console.error(`ERROR:queue-fail — no running row found for sec_id ${secId}`);
        process.exit(1);
      }
      console.log(`FAILED:${secId}`);
    } else if (cmd === "queue-status") {
      const row = dbGet(
        db,
        `SELECT sec_id FROM enrichment_queue WHERE status='running' ORDER BY started_at DESC LIMIT 1`,
      );
      console.log(row ? `RUNNING:${row.sec_id}` : "IDLE");
    } else if (cmd === "specialist-start") {
      const secId = Number(flags["sec-id"]);
      const specialist = flags["specialist"];
      const sessionKey = flags["session-key"] || "";
      if (!secId || !specialist)
        throw new Error("--sec-id and --specialist required");
      db.prepare(
        `INSERT OR REPLACE INTO pending_enrichments
           (sec_id, specialist, childSessionKey, status, spawned_at)
         VALUES (?, ?, ?, 'PENDING', datetime('now'))`,
      ).run(secId, specialist, sessionKey);
      console.log(`SPECIALIST_STARTED:${secId}:${specialist}`);
    } else if (cmd === "specialist-list") {
      const secId = Number(flags["sec-id"]);
      if (!secId) throw new Error("--sec-id required");
      const statusFilter = flags["status"] || null;
      const sql = statusFilter
        ? `SELECT specialist, childSessionKey, status, spawned_at
           FROM pending_enrichments WHERE sec_id=? AND status=? ORDER BY specialist`
        : `SELECT specialist, childSessionKey, status, spawned_at
           FROM pending_enrichments WHERE sec_id=? ORDER BY specialist`;
      const params = statusFilter ? [secId, statusFilter] : [secId];
      const rows = dbAll(db, sql, params);
      const now = Date.now();
      for (const r of rows) {
        const spawned = r.spawned_at
          ? new Date(r.spawned_at.includes("T") ? r.spawned_at : r.spawned_at.replace(" ", "T") + "Z").getTime()
          : now;
        const elapsedSecs = Math.floor((now - spawned) / 1000);
        console.log(`${r.status}:${r.specialist}:${r.childSessionKey}:${elapsedSecs}`);
      }
      if (rows.length === 0) console.log("NONE");
    } else if (cmd === "specialist-done") {
      const secId = Number(flags["sec-id"]);
      const specialist = flags["specialist"];
      if (!secId || !specialist)
        throw new Error("--sec-id and --specialist required");
      db.prepare(
        `UPDATE pending_enrichments SET status='DONE', completed_at=datetime('now')
         WHERE sec_id=? AND specialist=?`,
      ).run(secId, specialist);
      console.log(`SPECIALIST_DONE:${secId}:${specialist}`);
    } else if (cmd === "specialist-fail") {
      const secId = Number(flags["sec-id"]);
      const specialist = flags["specialist"];
      const error = flags["error"] || "timeout or no response";
      if (!secId || !specialist)
        throw new Error("--sec-id and --specialist required");
      db.prepare(
        `UPDATE pending_enrichments SET status='FAILED', completed_at=datetime('now'), error=?
         WHERE sec_id=? AND specialist=?`,
      ).run(error, secId, specialist);
      // Also log to error table
      const res = db
        .prepare(
          `INSERT INTO enrichment_errors (sec_id, specialist, error_type, error_message, logged_at)
         VALUES (?, ?, 'specialist_failed', ?, datetime('now'))`,
        )
        .run(secId, specialist, error);
      console.log(`SPECIALIST_FAILED:${secId}:${specialist}`);
    } else if (cmd === "log-error") {
      const secId = flags["sec-id"] ? Number(flags["sec-id"]) : null;
      const specialist = flags["specialist"] || null;
      const errorType = flags["error-type"] || "unknown";
      const message = flags["message"] || "";
      const context = flags["context"] || null;
      const res = db
        .prepare(
          `INSERT INTO enrichment_errors (sec_id, specialist, error_type, error_message, context_json, logged_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run(secId, specialist, errorType, message, context);
      console.log(`ERROR_LOGGED:${res.lastInsertRowid}`);
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
