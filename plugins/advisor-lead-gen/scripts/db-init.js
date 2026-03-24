#!/usr/bin/env node
/**
 * Advisor domain database initialization.
 * Ensures standardized domain tables (`entities`, `findings`) are present, plus
 * an advisor-specific SEC extension table (`advisor_profiles`).
 * Safe to run repeatedly (idempotent).
 *
 * Uses node:sqlite (built-in Node 22.5+) — no sqlite3 CLI required.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, resolveDomainDbPath } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = resolveDomainDbPath();

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      display_name TEXT,
      source_system TEXT,
      source_key TEXT,
      enriched_at DATETIME,
      lead_score INTEGER DEFAULT 0,
      lead_score_reason TEXT,
      validation_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS advisor_profiles (
      entity_id TEXT PRIMARY KEY,
      sec_id INTEGER NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      alternate_names TEXT,
      firm_id INTEGER,
      firm_name TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      registration_status TEXT,
      investment_advisor_only INTEGER,
      disclosure_flag TEXT,
      finra_registration_count INTEGER,
      employment_count INTEGER,
      last_updated_iapd TEXT,
      raw_employment_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(entity_id) REFERENCES entities(entity_id)
    );

    CREATE TABLE IF NOT EXISTS findings (
      finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      finding_type TEXT NOT NULL,
      finding_value TEXT,
      source_name TEXT,
      source_url TEXT,
      source_content TEXT,
      agent_name TEXT,
      confidence TEXT DEFAULT 'medium',
      is_trigger_event INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(entity_id) REFERENCES entities(entity_id),
      UNIQUE(entity_id, finding_type, finding_value, agent_name)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_enriched_at ON entities(enriched_at);
    CREATE INDEX IF NOT EXISTS idx_advisor_profiles_sec_id ON advisor_profiles(sec_id);
    CREATE INDEX IF NOT EXISTS idx_advisor_profiles_state ON advisor_profiles(state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedup ON findings(entity_id, finding_type, finding_value, agent_name);
    CREATE INDEX IF NOT EXISTS idx_findings_entity_type ON findings(entity_id, finding_type);
  `);
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const dbExisted = fs.existsSync(dbPath);

  const db = openDb(dbPath);
  try {
    initSchema(db);
    console.log(`${dbExisted ? "OK" : "CREATED"}:${dbPath}`);
  } catch (err) {
    console.error(`❌ Database initialization failed: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
