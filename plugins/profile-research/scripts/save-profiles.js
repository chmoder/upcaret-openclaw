#!/usr/bin/env node

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { openDb, resolveEnrichmentDbPath } from "./db.js";

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

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      middle_name TEXT,
      display_name TEXT,
      location_city TEXT,
      location_state TEXT,
      location_country TEXT DEFAULT 'US',
      current_employer TEXT,
      current_title TEXT,
      industry TEXT,
      source_system TEXT,
      source_key TEXT,
      source_data TEXT,
      enriched_at DATETIME,
      enrichment_score INTEGER DEFAULT 0,
      enrichment_score_reason TEXT,
      enrichment_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS findings (
      finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      finding_type TEXT NOT NULL,
      finding_value TEXT,
      source_name TEXT,
      source_url TEXT,
      source_content TEXT,
      agent_name TEXT,
      confidence TEXT DEFAULT 'medium',
      is_trigger_event INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(profile_id) REFERENCES profiles(profile_id),
      UNIQUE(profile_id, finding_type, finding_value, agent_name)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_source_key
      ON profiles(source_system, source_key);
    CREATE INDEX IF NOT EXISTS idx_findings_profile_type
      ON findings(profile_id, finding_type);
  `);
}

function normalizeProfiles(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.profiles)) return payload.profiles;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function splitDisplayName(displayName) {
  const parts = String(displayName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1],
  };
}

function toSourceKey(profile) {
  const raw =
    String(profile.source_key || "").trim() ||
    [
      String(profile.display_name || "").trim().toLowerCase(),
      String(profile.current_employer || "").trim().toLowerCase(),
      String(profile.location_city || "").trim().toLowerCase(),
      String(profile.location_state || "").trim().toLowerCase(),
    ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function asString(value) {
  return String(value ?? "").trim();
}

function upsertProfile(db, profile) {
  const sourceSystem = "profile_research";
  const sourceKey = toSourceKey(profile);
  const existingBySource = db
    .prepare(
      `SELECT profile_id
       FROM profiles
       WHERE source_system = ? AND source_key = ?
       LIMIT 1`,
    )
    .get(sourceSystem, sourceKey);
  const profileId = existingBySource?.profile_id || randomUUID();

  const displayName = asString(profile.display_name);
  const split = splitDisplayName(displayName);
  const firstName = asString(profile.first_name) || split.firstName;
  const lastName = asString(profile.last_name) || split.lastName;
  if (!firstName || !lastName) {
    return { action: "skipped", profileId: null };
  }

  const sourceData = {
    source_url: asString(profile.source_url),
    request_context: profile.request_context ?? null,
    raw_profile: profile,
  };

  db.prepare(
    `INSERT INTO profiles (
      profile_id, first_name, last_name, middle_name, display_name,
      location_city, location_state, location_country,
      current_employer, current_title, industry,
      source_system, source_key, source_data,
      enriched_at, enrichment_status, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      NULL, 'pending', datetime('now')
    )
    ON CONFLICT(profile_id) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      middle_name = excluded.middle_name,
      display_name = excluded.display_name,
      location_city = excluded.location_city,
      location_state = excluded.location_state,
      location_country = excluded.location_country,
      current_employer = excluded.current_employer,
      current_title = excluded.current_title,
      industry = excluded.industry,
      source_system = excluded.source_system,
      source_key = excluded.source_key,
      source_data = excluded.source_data,
      updated_at = datetime('now')`,
  ).run(
    profileId,
    firstName,
    lastName,
    asString(profile.middle_name),
    displayName || `${firstName} ${lastName}`.trim(),
    asString(profile.location_city),
    asString(profile.location_state),
    asString(profile.location_country) || "US",
    asString(profile.current_employer),
    asString(profile.current_title),
    asString(profile.industry),
    sourceSystem,
    sourceKey,
    JSON.stringify(sourceData),
  );

  return { action: existingBySource ? "updated" : "inserted", profileId };
}

function main() {
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

  const profiles = normalizeProfiles(payload);
  if (profiles.length === 0) {
    throw new Error("payload must include a profile object or profiles array");
  }

  const dbPath = resolveEnrichmentDbPath();
  const db = openDb(dbPath);
  try {
    ensureSchema(db);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const profile of profiles) {
      const outcome = upsertProfile(db, profile);
      if (outcome.action === "skipped" || !outcome.profileId) {
        skipped++;
        continue;
      }
      if (outcome.action === "inserted") inserted++;
      if (outcome.action === "updated") updated++;
    }

    console.log(
      `SAVED:${JSON.stringify({
        inserted,
        updated,
        skipped,
        profiles_total: profiles.length,
        db_path: dbPath,
      })}`,
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
