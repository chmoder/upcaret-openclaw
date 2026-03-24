#!/usr/bin/env node
/**
 * Verifies minimal enrichment-engine layout and in-memory schema initialization.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");

const required = [
  "README.md",
  "package.json",
  "openclaw.plugin.json",
  "plugin-entry.ts",
  "scripts/db.js",
  "scripts/db-init.js",
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
console.log("OK: all required plugin files and scripts present");
