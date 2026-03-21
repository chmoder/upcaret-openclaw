#!/usr/bin/env node
/**
 * Idempotent skill bootstrap — safe to run multiple times.
 * - Verifies node + sqlite3 CLI
 * - Ensures SQLite schema (db-init.js)
 * - Verifies specialist prompts + core scripts exist
 *
 * Does NOT: create OpenClaw agents, set gateway env, or register sessions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const REQUIRED_PATHS = [
  'scripts/extract-advisors.js',
  'scripts/orchestrator.js',
  'scripts/db-init.js',
  'scripts/status-dashboard.js',
  'scripts/env.js',
  'agents/profile.md',
  'agents/scorer.md',
  'agents/orchestrator.md',
];

function checkBinary(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [name], { encoding: 'utf8' });
  return r.status === 0;
}

function main() {
  console.log('🔧 advisor-lead-gen bootstrap (idempotent)\n');

  let failed = false;

  if (!checkBinary('sqlite3')) {
    console.error('❌ sqlite3 CLI not found on PATH (required for db-init and orchestrator).');
    failed = true;
  } else {
    console.log('OK  sqlite3');
  }

  for (const rel of REQUIRED_PATHS) {
    const full = path.join(ROOT, rel);
    const ok = fs.existsSync(full);
    console.log(ok ? `OK  ${rel}` : `❌ missing ${rel}`);
    if (!ok) failed = true;
  }

  if (failed) {
    console.error('\nBootstrap stopped (fix errors above).');
    process.exit(1);
  }

  console.log('\n📦 Running db:init (idempotent)...\n');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'db-init.js')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (e) {
    console.error(`\n❌ db-init failed: ${e.message}`);
    process.exit(1);
  }

  console.log('\n✅ Bootstrap complete. Same command is safe to run again.\n');
  console.log('Next (OpenClaw):');
  console.log('  • npm run setup:openclaw   # print openclaw agents/config/sessions_send steps');
  console.log('  • Enrichment: set BRAVE_API_KEY (see npm run env:help)');
  console.log('  • Send ENRICH:{...} via sessions_send (see references/OPENCLAW_RUNTIME.md)');
}

main();
