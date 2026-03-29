#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readRawArg() {
  if (process.argv[2] === "--file") {
    const filePath = process.argv[3];
    if (!filePath) {
      throw new Error("--file requires a path");
    }
    return fs.readFileSync(filePath, "utf8");
  }
  return process.argv[2];
}

function resolveEnrichmentSaveCliPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const candidates = [
    process.env.ENRICHMENT_WORKSPACE
      ? path.join(process.env.ENRICHMENT_WORKSPACE, "scripts", "save-profiles.js")
      : null,
    path.join(__dirname, "..", "..", "enrichment", "scripts", "save-profiles.js"),
    path.join(
      process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
      "extensions",
      "enrichment",
      "scripts",
      "save-profiles.js",
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find enrichment save-profiles CLI. Set ENRICHMENT_WORKSPACE or install enrichment extension.",
  );
}

async function main() {
  const raw = readRawArg();
  if (!raw) {
    throw new Error("no JSON argument provided");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON - ${err.message}`);
  }

  const saveCliPath = resolveEnrichmentSaveCliPath();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-research-save-"));
  const payloadPath = path.join(tempDir, "payload.json");
  fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf8");

  const run = spawnSync(process.execPath, [saveCliPath, "--file", payloadPath], {
    env: {
      ...process.env,
      PROFILE_DATA_DEFAULT_SOURCE_SYSTEM: "profile_research",
    },
    encoding: "utf8",
  });
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (run.error) {
    throw run.error;
  }
  if (run.status !== 0) {
    throw new Error(String(run.stderr || run.stdout || "save-profiles failed").trim());
  }
  process.stdout.write(String(run.stdout || ""));
}

try {
  await main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
