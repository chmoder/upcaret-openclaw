#!/usr/bin/env node
/**
 * reset-queue.js — Flush the enrichment queue and advisor-enrich session inbox.
 *
 * Clears:
 *   - enrichment_queue rows that are not 'done' (queued, running, failed)
 *   - pending_enrichments rows (in-flight specialist tracking)
 *   - The advisor-enrich OpenClaw session (destroys session inbox and history)
 *
 * Preserves:
 *   - enrichment_queue rows with status='done'
 *   - advisor_findings and advisors table (enriched data is never touched)
 *   - enrichment_errors log
 *
 * Usage:
 *   node scripts/reset-queue.js [--session-dir <path>] [--dry-run]
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "./db.js";
import { initSchema } from "./db-init.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "..", "advisors.db");

// Default session directory — prefer OPENCLAW_HOME env, then $HOME, then container default
const OPENCLAW_BASE = process.env.OPENCLAW_HOME
  || (process.env.HOME ? path.join(process.env.HOME, '.openclaw') : '/home/node/.openclaw');
const DEFAULT_SESSION_DIR = path.join(OPENCLAW_BASE, 'agents', 'advisor-enrich', 'sessions');

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
  const results = { db_queue_cleared: 0, db_pending_cleared: 0, session_files_removed: [] };

  // 1. Clear DB queue (non-done rows only)
  const db = openDb(DB_PATH);
  try {
    initSchema(db); // ensure tables exist even if db-init hasn't been run yet
    if (opts.dryRun) {
      // Count what would be deleted without touching the DB.
      const qCount = db.prepare(`SELECT COUNT(*) AS n FROM enrichment_queue WHERE status != 'done'`).get();
      const pCount = db.prepare(`SELECT COUNT(*) AS n FROM pending_enrichments`).get();
      results.db_queue_cleared = qCount.n;
      results.db_pending_cleared = pCount.n;
    } else {
      const qResult = db.prepare(`DELETE FROM enrichment_queue WHERE status != 'done'`).run();
      results.db_queue_cleared = qResult.changes;

      const pResult = db.prepare(`DELETE FROM pending_enrichments`).run();
      results.db_pending_cleared = pResult.changes;
    }
  } finally {
    db.close();
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
    console.log(`  DELETE FROM enrichment_queue WHERE status != 'done'`);
    console.log(`  DELETE FROM pending_enrichments`);
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
