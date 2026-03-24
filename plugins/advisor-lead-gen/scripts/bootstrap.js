#!/usr/bin/env node
/**
 * Idempotent skill bootstrap — safe to run multiple times.
 * - Verifies node:sqlite is available (built-in Node 22.5+)
 * - Ensures SQLite schema (db-init.js)
 * - Verifies specialist prompts + core scripts exist
 *
 * Does NOT: create OpenClaw agents, set gateway env, or register sessions.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { openDb, resolveDomainDbPath } from "./db.js";
import { initSchema } from "./db-init.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

const require = createRequire(import.meta.url);

const REQUIRED_PATHS = [
  "IDENTITY.md",
  "scripts/extract-advisors.js",
  "scripts/enqueue-enrich.js",
  "scripts/record-enrichment.js",
  "scripts/save-enrichment.js",
  "scripts/engine-db.js",
  "scripts/db-init.js",
  "scripts/status-dashboard.js",
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

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    applyOpenclawConfig: args.includes("--apply-openclaw-config"),
    maxChildrenPerAgent: (() => {
      const i = args.indexOf("--max-children-per-agent");
      if (i !== -1 && args[i + 1]) return parseInt(args[i + 1], 10);
      return 12;
    })(),
  };
}

function ensureMaxChildrenPerAgent({ apply, target }) {
  const minRecommended = 10;
  const desired = Number.isFinite(target) ? target : 12;

  const read = spawnSync(
    "openclaw",
    ["config", "print", "--json"],
    { encoding: "utf8" },
  );
  if (read.error) {
    console.log("WARN OpenClaw CLI not found; skipping sub-agent limit check.");
    return;
  }

  let cfg = null;
  try {
    cfg = JSON.parse(String(read.stdout || "{}"));
  } catch {
    console.log("WARN Could not parse `openclaw config print --json`; skipping sub-agent limit check.");
    return;
  }

  const current = Number(
    cfg?.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5,
  );
  if (Number.isFinite(current) && current >= minRecommended) {
    console.log(`OK  OpenClaw sub-agent limit: agents.defaults.subagents.maxChildrenPerAgent=${current}`);
    return;
  }

  const msg =
    `WARN OpenClaw sub-agent limit is too low for advisor enrichment (needs >=${minRecommended}; found ${Number.isFinite(current) ? current : "unknown"}).`;
  console.log(msg);
  console.log("     Without this you may see: gateway max active children limit reached (5/5)");
  console.log(`     Fix: openclaw config set agents.defaults.subagents.maxChildrenPerAgent ${desired}`);
  console.log("     Then: openclaw gateway restart");

  if (!apply) return;

  const set = spawnSync(
    "openclaw",
    ["config", "set", "agents.defaults.subagents.maxChildrenPerAgent", String(desired)],
    { encoding: "utf8" },
  );
  if (set.status === 0) {
    console.log(`✅ Applied: agents.defaults.subagents.maxChildrenPerAgent=${desired} (restart gateway to apply)`);
  } else {
    console.log("WARN Failed to apply OpenClaw config automatically.");
    const out = String(set.stdout || "").trim();
    const err = String(set.stderr || "").trim();
    if (err) console.log(err.slice(0, 2000));
    else if (out) console.log(out.slice(0, 2000));
  }
}

function main() {
  const opts = parseArgs(process.argv);
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
    const dbPath = resolveDomainDbPath();
    const db = openDb(dbPath);
    try {
      initSchema(db);
      console.log(`✅ Schema ready: ${dbPath}`);
    } finally {
      db.close();
    }
  } catch (e) {
    console.error(`\n❌ db-init failed: ${e.message}`);
    process.exit(1);
  }

  console.log("\n🔐 Checking OpenClaw sub-agent limits...\n");
  ensureMaxChildrenPerAgent({
    apply: opts.applyOpenclawConfig,
    target: opts.maxChildrenPerAgent,
  });

  console.log("\n✅ Bootstrap complete. Same command is safe to run again.\n");
  console.log("Next (OpenClaw):");
  console.log(
    "  • Install plugins: openclaw plugins install enrichment-engine && openclaw plugins install advisor-lead-gen",
  );
  console.log('  • Set key: openclaw config set env.BRAVE_API_KEY "<key>"');
  console.log(
    '  • Optional Firecrawl: openclaw config set env.FIRECRAWL_API_KEY "<fc-key>" (if gateway uses it for web_fetch)',
  );
  console.log("  • Restart gateway: openclaw gateway restart");
  console.log("  • Enqueue advisors: npm run enqueue -- --sec-id <ID>");
}

main();
