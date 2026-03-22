#!/usr/bin/env node
/**
 * Idempotent skill bootstrap — safe to run multiple times.
 * - Verifies node:sqlite is available (built-in Node 22.5+)
 * - Ensures SQLite schema (db-init.js)
 * - Verifies specialist prompts + core scripts exist
 *
 * Does NOT: create OpenClaw agents, set gateway env, or register sessions.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const REQUIRED_PATHS = [
  "IDENTITY.md",
  "scripts/extract-advisors.js",
  "scripts/enqueue-enrich.js",
  "scripts/record-enrichment.js",
  "scripts/save-enrichment.js",
  "scripts/dispatch-cron.js",
  "scripts/db-init.js",
  "scripts/status-dashboard.js",
  "scripts/env.js",
  "agents/profile.md",
  "agents/scorer.md",
];

function checkNodeSqlite() {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log("🔧 advisor-lead-gen bootstrap (idempotent)\n");

  let failed = false;

  const nodeVersion = process.versions.node;
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(
      `❌ Node.js ${nodeVersion} is too old. node:sqlite requires Node 22.5+ (found ${nodeVersion}).`,
    );
    console.error("   Upgrade Node.js: https://nodejs.org/en/download");
    failed = true;
  } else if (!checkNodeSqlite()) {
    console.error(
      `❌ node:sqlite unavailable despite Node ${nodeVersion}. Check your Node build.`,
    );
    failed = true;
  } else {
    console.log(`OK  node:sqlite (Node ${nodeVersion})`);
  }

  for (const rel of REQUIRED_PATHS) {
    const full = path.join(ROOT, rel);
    const ok = fs.existsSync(full);
    console.log(ok ? `OK  ${rel}` : `❌ missing ${rel}`);
    if (!ok) failed = true;
  }

  if (failed) {
    console.error("\nBootstrap stopped (fix errors above).");
    process.exit(1);
  }

  console.log("\n📦 Running db:init (idempotent)...\n");
  try {
    // Call db-init directly (no child process spawn needed)
    const { initSchema } = require("./db-init");
    const { openDb } = require("./db");
    const dbPath = path.join(ROOT, "advisors.db");
    const db = openDb(dbPath);
    try {
      initSchema(db);
      console.log("✅ Schema ready: advisors.db");
    } finally {
      db.close();
    }
  } catch (e) {
    console.error(`\n❌ db-init failed: ${e.message}`);
    process.exit(1);
  }

  console.log("\n✅ Bootstrap complete. Same command is safe to run again.\n");
  console.log("Next (OpenClaw):");
  console.log(
    "  • npm run setup:openclaw   # agents, env, default session:advisor-orchestrator, ENRICH/TICK/STATUS, cron example",
  );
  console.log("  • Enrichment: set BRAVE_API_KEY (see npm run env:help)");
  console.log(
    "  • npm run cron                # start dispatch-cron.js — required, fires ENRICH to the agent",
  );
}

main();
