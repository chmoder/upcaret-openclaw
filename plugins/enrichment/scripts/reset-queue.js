#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db.js";
import { initSchema } from "./db-init.js";

const OPENCLAW_BASE =
  process.env.OPENCLAW_HOME ||
  (process.env.HOME
    ? `${process.env.HOME}/.openclaw`
    : `${os.homedir()}/.openclaw`);
const DEFAULT_AGENT_ID = process.env.ENRICH_ORCH_AGENT_ID || "profile-enrich";
const DEFAULT_SESSION_DIR = `${OPENCLAW_BASE}/agents/${DEFAULT_AGENT_ID}/sessions`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { sessionDir: DEFAULT_SESSION_DIR, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session-dir" && args[i + 1]) out.sessionDir = args[++i];
    if (args[i] === "--dry-run") out.dryRun = true;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  const results = {
    jobs_cleared: 0,
    specialist_runs_cleared: 0,
    events_cleared: 0,
    session_files_removed: [],
  };

  const db = openDb();
  try {
    initSchema(db);
    const targetJobs = db
      .prepare(
        `SELECT job_id
         FROM enrichment_jobs
         WHERE status != 'done'`,
      )
      .all()
      .map((r) => String(r.job_id));

    if (!opts.dryRun && targetJobs.length > 0) {
      const placeholders = targetJobs.map(() => "?").join(", ");
      results.specialist_runs_cleared = db
        .prepare(
          `DELETE FROM enrichment_specialist_runs
           WHERE job_id IN (${placeholders})`,
        )
        .run(...targetJobs).changes;
      results.events_cleared = db
        .prepare(
          `DELETE FROM enrichment_events
           WHERE job_id IN (${placeholders})`,
        )
        .run(...targetJobs).changes;
      results.jobs_cleared = db
        .prepare(
          `DELETE FROM enrichment_jobs
           WHERE job_id IN (${placeholders})`,
        )
        .run(...targetJobs).changes;
    } else if (opts.dryRun) {
      results.jobs_cleared = targetJobs.length;
    }
  } finally {
    db.close();
  }

  if (fs.existsSync(opts.sessionDir)) {
    const files = fs
      .readdirSync(opts.sessionDir)
      .filter((f) => f === "sessions.json" || f.endsWith(".jsonl"));
    for (const f of files) {
      const fullPath = path.join(opts.sessionDir, f);
      if (!opts.dryRun) fs.unlinkSync(fullPath);
      results.session_files_removed.push(f);
    }
  } else {
    results.session_dir_missing = opts.sessionDir;
  }

  if (opts.dryRun) {
    console.log(`DRY_RUN:${JSON.stringify(results)}`);
  } else {
    console.log(`RESET_DONE:${JSON.stringify(results)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
