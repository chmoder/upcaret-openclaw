#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDbPath = path.join(__dirname, "..", "enrichment.db");

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_pipelines (
      pipeline_id TEXT PRIMARY KEY,
      name TEXT,
      orchestrator_agent_id TEXT NOT NULL,
      orchestrator_workspace TEXT,
      message_prefix TEXT NOT NULL DEFAULT 'ENRICH',
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      stale_minutes INTEGER NOT NULL DEFAULT 5,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enrichment_jobs (
      job_id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      orchestrator_agent_id TEXT,
      orchestrator_workspace TEXT,
      message_prefix TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      result_json TEXT,
      FOREIGN KEY(pipeline_id) REFERENCES enrichment_pipelines(pipeline_id)
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

    CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_queued
      ON enrichment_jobs(status, priority DESC, queued_at ASC);
    CREATE INDEX IF NOT EXISTS idx_jobs_entity
      ON enrichment_jobs(entity_type, entity_id, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_status
      ON enrichment_jobs(pipeline_id, status, queued_at ASC);
    CREATE INDEX IF NOT EXISTS idx_specialist_job_status
      ON enrichment_specialist_runs(job_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_job_created
      ON enrichment_events(job_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_entity
      ON enrichment_jobs(pipeline_id, entity_id)
      WHERE status IN ('queued', 'running');
  `);
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const dbPath = process.argv[2] || process.env.ENRICHMENT_ENGINE_DB_PATH || defaultDbPath;
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
