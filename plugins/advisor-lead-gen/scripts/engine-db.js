import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export function resolveEngineDbPath() {
  if (process.env.ENRICHMENT_ENGINE_DB_PATH) {
    return process.env.ENRICHMENT_ENGINE_DB_PATH;
  }
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "enrichment", "enrichment.db");
}

export function openEngineDb(dbPath = resolveEngineDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

export function initEngineSchema(db) {
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

export function ensureAdvisorPipeline(db) {
  const agentId = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
  const workspacePath =
    process.env.ADVISOR_ORCH_WORKSPACE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  db.prepare(
    `INSERT INTO enrichment_pipelines
       (pipeline_id, name, orchestrator_agent_id, orchestrator_workspace, message_prefix, max_concurrency, stale_minutes, enabled)
     VALUES
       ('advisors', 'Advisor Enrichment', ?, ?, 'ENRICH', 1, 5, 1)
     ON CONFLICT(pipeline_id) DO UPDATE SET
       orchestrator_agent_id = excluded.orchestrator_agent_id,
       orchestrator_workspace = excluded.orchestrator_workspace,
       message_prefix = excluded.message_prefix,
       enabled = excluded.enabled,
       updated_at = datetime('now')`,
  ).run(agentId, workspacePath);
}

export function advisorEntityId(secId) {
  return `advisor:${Number(secId)}`;
}

export function secIdFromEntityId(entityId) {
  const value = String(entityId || "");
  if (!value.startsWith("advisor:")) return null;
  const n = Number(value.slice("advisor:".length));
  return Number.isFinite(n) ? n : null;
}

export function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
