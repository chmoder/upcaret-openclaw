#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveEnrichmentPullDataCliPath() {
  const candidates = [
    process.env.ENRICHMENT_WORKSPACE
      ? path.join(process.env.ENRICHMENT_WORKSPACE, "scripts", "pull-data.js")
      : null,
    path.join(__dirname, "..", "..", "enrichment", "scripts", "pull-data.js"),
    path.join(
      process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
      "extensions",
      "enrichment",
      "scripts",
      "pull-data.js",
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find enrichment pull-data CLI. Set ENRICHMENT_WORKSPACE or install enrichment extension.",
  );
}

function main() {
  const pullDataCliPath = resolveEnrichmentPullDataCliPath();

  const run = spawnSync(process.execPath, [pullDataCliPath, ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
  });

  if (run.error) {
    throw run.error;
  }
  process.exit(run.status || 0);
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
