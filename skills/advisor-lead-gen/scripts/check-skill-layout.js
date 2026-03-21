#!/usr/bin/env node
/**
 * Verifies minimal skill layout (no API keys).
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const required = [
  'scripts/extract-advisors.js',
  'scripts/orchestrator.js',
  'scripts/db-init.js',
  'scripts/status-dashboard.js',
  'scripts/env.js',
  'agents/profile.md',
  'agents/scorer.md'
];

let ok = true;
for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`Missing: ${rel}`);
    ok = false;
  }
}
if (!ok) process.exit(1);
console.log('OK: extract-advisors + orchestrator + prompts + db-init + env');
