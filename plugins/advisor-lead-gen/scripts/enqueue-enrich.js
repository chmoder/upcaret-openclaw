#!/usr/bin/env node
/**
 * enqueue-enrich.js — Queue one specific advisor for enrichment.
 *
 * Writes one enrichment_queue row for the given advisor. That is all this
 * script does — it does NOT send ENRICH to the agent.
 *
 * dispatch-cron.js is the only process that reads the queue and sends ENRICH
 * to the advisor-enrich agent via `openclaw agent`. Without dispatch-cron.js
 * running, queued rows are never processed.
 *
 * Typical usage:
 *   node scripts/enqueue-enrich.js --sec-id 4167394
 *   # → QUEUED:4167394 (dispatch-cron.js picks it up within 5s)
 *
 * Usage:
 *   node scripts/enqueue-enrich.js --sec-id <SEC_ID>
 *
 * Output:
 *   QUEUED:<sec_id>               — row written to enrichment_queue
 *   SKIP:<sec_id>:already_active  — already queued or running, do nothing
 *   ERROR:<message>               — advisor not found or DB error
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbGet, openDb } from "./db.js";
import { initSchema } from "./db-init.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "..", "advisors.db");

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

  const db = openDb(DB_PATH);
  try {
    initSchema(db);

    // Skip if this advisor is already queued or running.
    const active = dbGet(
      db,
      `SELECT status FROM enrichment_queue WHERE sec_id = ? AND status IN ('queued','running')`,
      [secId],
    );
    if (active) {
      console.log(`SKIP:${secId}:already_active (status=${active.status})`);
      return;
    }

    // Look up the advisor.
    const a = dbGet(
      db,
      `SELECT sec_id, first_name, last_name, firm_name, city, state
       FROM advisors WHERE sec_id = ?`,
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
    const json = JSON.stringify(payload);

    db.prepare(
      `INSERT INTO enrichment_queue (sec_id, advisor_json, status, queued_at)
       VALUES (?, ?, 'queued', datetime('now'))`,
    ).run(Number(a.sec_id), json);

    console.log(`QUEUED:${a.sec_id}`);
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
