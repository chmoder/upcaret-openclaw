#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openDb, resolveEnrichmentDbPath } from "./db.js";

export function initSchema(db) {
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

    CREATE TABLE IF NOT EXISTS enrichment_jobs (
      job_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      orchestrator_agent_id TEXT,
      orchestrator_workspace TEXT,
      message_prefix TEXT NOT NULL DEFAULT 'ENRICH',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      result_json TEXT,
      FOREIGN KEY(profile_id) REFERENCES profiles(profile_id)
    );

    CREATE TABLE IF NOT EXISTS enrichment_specialist_runs (
      specialist_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      specialist_name TEXT NOT NULL,
      child_session_key TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      spawned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error TEXT,
      result_json TEXT,
      FOREIGN KEY(job_id) REFERENCES enrichment_jobs(job_id),
      UNIQUE(job_id, specialist_name)
    );

    CREATE TABLE IF NOT EXISTS enrichment_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      event_type TEXT NOT NULL,
      message TEXT,
      context_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(job_id) REFERENCES enrichment_jobs(job_id)
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_source ON profiles(source_system, source_key);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_source_key ON profiles(source_system, source_key);
    CREATE INDEX IF NOT EXISTS idx_profiles_enrichment_status ON profiles(enrichment_status, enriched_at);
    CREATE INDEX IF NOT EXISTS idx_findings_profile_type
      ON findings(profile_id, finding_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_queued
      ON enrichment_jobs(status, priority DESC, queued_at ASC);
    CREATE INDEX IF NOT EXISTS idx_jobs_profile
      ON enrichment_jobs(profile_id, queued_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_profile
      ON enrichment_jobs(profile_id)
      WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS idx_specialist_job_status
      ON enrichment_specialist_runs(job_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_job_created
      ON enrichment_events(job_id, created_at DESC);
  `);
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const dbPath = process.argv[2] || resolveEnrichmentDbPath();
  const existed = fs.existsSync(dbPath);
  const db = openDb(dbPath);
  try {
    initSchema(db);
    console.log(`${existed ? "OK" : "CREATED"}:${dbPath}`);
  } catch (err) {
    console.error(`ERROR:${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
