#!/usr/bin/env node

import fs from "node:fs";
import { saveProfilesPayload } from "./profile-data-api.js";

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
  const result = saveProfilesPayload(payload, {
    defaultSourceSystem:
      String(process.env.PROFILE_DATA_DEFAULT_SOURCE_SYSTEM || "").trim() ||
      "profile_research",
  });
  console.log(`SAVED:${JSON.stringify(result)}`);
}

try {
  await main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
