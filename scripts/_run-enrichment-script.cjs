#!/usr/bin/env node
/**
 * Delegates to plugins/enrichment/scripts/<name> so `node scripts/<name>` works
 * from this repo root (cwd does not need to be ~/.openclaw/workspace).
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const name = process.env._ENRICH_SCRIPT;
if (!name) {
  console.error("ERROR: _ENRICH_SCRIPT not set");
  process.exit(1);
}
const target = path.join(
  __dirname,
  "..",
  "plugins",
  "enrichment",
  "scripts",
  name,
);
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status == null ? 1 : r.status);
