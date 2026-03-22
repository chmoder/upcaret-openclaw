#!/usr/bin/env node
/**
 * Verifies minimal skill layout (no API keys).
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const required = [
  "SKILL.md",
  "IDENTITY.md",
  "scripts/db.js",
  "scripts/db-init.js",
  "scripts/extract-advisors.js",
  "scripts/enqueue-enrich.js",
  "scripts/record-enrichment.js",
  "scripts/save-enrichment.js",
  "scripts/dispatch-cron.js",
  "scripts/status-dashboard.js",
  "scripts/env.js",
  "agents/profile.md",
  "agents/scorer.md",
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
console.log("OK: IDENTITY.md + extract-advisors + enqueue + record/save + dispatch-cron + prompts + db + env");
