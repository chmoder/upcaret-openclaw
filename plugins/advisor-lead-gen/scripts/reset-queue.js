#!/usr/bin/env node
/**
 * reset-queue.js — Flush advisor jobs from enrichment.db and reset advisor-enrich session.
 *
 * Clears:
 *   - enrichment_jobs rows for pipeline='advisors' that are not done
 *   - enrichment_specialist_runs and enrichment_events attached to those jobs
 *   - The advisor-enrich OpenClaw session (destroys session inbox and history)
 *
 * Preserves:
 *   - done enrichment_jobs rows
 *   - domain tables in advisors.db (entities/advisor_profiles/findings)
 *
 * Usage:
 *   node scripts/reset-queue.js [--session-dir <path>] [--dry-run]
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initEngineSchema, openEngineDb, resolveEngineDbPath } from "./engine-db.js";

// Default session directory — prefer OPENCLAW_HOME env, then $HOME, then container default
const OPENCLAW_BASE = process.env.OPENCLAW_HOME
  || (process.env.HOME ? `${process.env.HOME}/.openclaw` : `${os.homedir()}/.openclaw`);
const DEFAULT_SESSION_DIR = `${OPENCLAW_BASE}/agents/advisor-enrich/sessions`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { sessionDir: DEFAULT_SESSION_DIR, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-dir' && args[i + 1]) out.sessionDir = args[++i];
    if (args[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  const results = {
    engine_jobs_cleared: 0,
    specialist_runs_cleared: 0,
    events_cleared: 0,
    session_files_removed: [],
  };

  const engineDb = openEngineDb(resolveEngineDbPath());
  try {
    initEngineSchema(engineDb);
    const targetJobs = engineDb
      .prepare(
        `SELECT job_id
         FROM enrichment_jobs
         WHERE pipeline_id='advisors' AND status != 'done'`,
      )
      .all()
      .map((r) => String(r.job_id));

    if (opts.dryRun) {
      results.engine_jobs_cleared = targetJobs.length;
      if (targetJobs.length > 0) {
        const placeholders = targetJobs.map(() => "?").join(", ");
        results.specialist_runs_cleared = Number(
          engineDb
            .prepare(
              `SELECT COUNT(*) AS n
               FROM enrichment_specialist_runs
               WHERE job_id IN (${placeholders})`,
            )
            .get(...targetJobs)?.n || 0,
        );
        results.events_cleared = Number(
          engineDb
            .prepare(
              `SELECT COUNT(*) AS n
               FROM enrichment_events
               WHERE job_id IN (${placeholders})`,
            )
            .get(...targetJobs)?.n || 0,
        );
      }
    } else {
      if (targetJobs.length > 0) {
        const placeholders = targetJobs.map(() => "?").join(", ");
        const specialistResult = engineDb
          .prepare(
            `DELETE FROM enrichment_specialist_runs
             WHERE job_id IN (${placeholders})`,
          )
          .run(...targetJobs);
        results.specialist_runs_cleared = specialistResult.changes;

        const eventsResult = engineDb
          .prepare(
            `DELETE FROM enrichment_events
             WHERE job_id IN (${placeholders})`,
          )
          .run(...targetJobs);
        results.events_cleared = eventsResult.changes;

        const jobsResult = engineDb
          .prepare(
            `DELETE FROM enrichment_jobs
             WHERE job_id IN (${placeholders})`,
          )
          .run(...targetJobs);
        results.engine_jobs_cleared = jobsResult.changes;
      }
    }
  } finally {
    engineDb.close();
  }

  // 2. Remove advisor-enrich session files (clears OpenClaw inbox + history)
  if (fs.existsSync(opts.sessionDir)) {
    const files = fs.readdirSync(opts.sessionDir).filter(f =>
      f === 'sessions.json' || f.endsWith('.jsonl')
    );
    for (const f of files) {
      const fullPath = path.join(opts.sessionDir, f);
      if (!opts.dryRun) {
        fs.unlinkSync(fullPath);
      }
      results.session_files_removed.push(f);
    }
  } else {
    results.session_dir_missing = opts.sessionDir;
  }

  if (opts.dryRun) {
    console.log(`DRY_RUN — would have done:`);
    console.log(`  DELETE advisor pipeline jobs from enrichment_jobs WHERE status != 'done'`);
    console.log(`  DELETE matching rows from enrichment_specialist_runs and enrichment_events`);
    console.log(`  Remove session files: ${results.session_files_removed.join(', ') || 'none found'}`);
  } else {
    console.log(`RESET_DONE:${JSON.stringify(results)}`);
    console.log(`\nQueue cleared. Next time the advisor-enrich agent receives a message, it will start a fresh session.`);
    console.log(`Run 'openclaw agent --agent advisor-enrich --message STATUS' to warm it up.`);
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
