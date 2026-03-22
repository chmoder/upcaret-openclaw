#!/usr/bin/env node

/**
 * SEC IAPD Advisor Database Initialization
 * Ensures SQLite database schema for advisors/findings is present.
 * Safe to run repeatedly (idempotent).
 *
 * Uses node:sqlite (built-in Node 22.5+) — no sqlite3 CLI required.
 */

const path = require('path');
const fs = require('fs');
const { openDb, dbRun, dbAll } = require('./db');

const dbPath = path.join(__dirname, '../advisors.db');

function ensureColumn(db, table, column, definition) {
  const cols = dbAll(db, `PRAGMA table_info(${table});`).map((c) => c.name);
  if (!cols.includes(column)) {
    dbRun(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    console.log(`✅ Column added: ${table}.${column}`);
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS advisors (
      sec_id INTEGER PRIMARY KEY,
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
      email TEXT,
      phone TEXT,
      firm_website TEXT,
      linkedin_url TEXT,
      linkedin_handle TEXT,
      lead_score INTEGER DEFAULT 0,
      lead_score_reason TEXT,
      validation_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      enriched_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS advisor_findings (
      finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
      sec_id INTEGER NOT NULL,
      finding_type TEXT NOT NULL,
      finding_value TEXT,
      source_name TEXT,
      source_url TEXT,
      source_content TEXT,
      agent_name TEXT,
      confidence TEXT DEFAULT 'medium',
      is_trigger_event INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sec_id) REFERENCES advisors(sec_id),
      UNIQUE(sec_id, finding_type, finding_value, agent_name)
    );
    CREATE TABLE IF NOT EXISTS pending_enrichments (
      sec_id INTEGER NOT NULL,
      specialist TEXT NOT NULL,
      childSessionKey TEXT NOT NULL,
      runId TEXT,
      advisor_json TEXT,
      result_json TEXT,
      spawned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT NOT NULL DEFAULT 'PENDING',
      error TEXT,
      PRIMARY KEY (sec_id, specialist)
    );
    CREATE TABLE IF NOT EXISTS enrichment_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sec_id INTEGER NOT NULL,
      advisor_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      lead_score INTEGER,
      error TEXT,
      FOREIGN KEY(sec_id) REFERENCES advisors(sec_id)
    );
    CREATE TABLE IF NOT EXISTS enrichment_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sec_id INTEGER,
      specialist TEXT,
      error_type TEXT NOT NULL,
      error_message TEXT,
      context_json TEXT,
      logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_advisors_enriched_at ON advisors(enriched_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedup ON advisor_findings(sec_id, finding_type, finding_value, agent_name);
    CREATE INDEX IF NOT EXISTS idx_findings_sec_type ON advisor_findings(sec_id, finding_type);
    CREATE INDEX IF NOT EXISTS idx_pending_enrichments_status ON pending_enrichments(status);
    CREATE INDEX IF NOT EXISTS idx_pending_enrichments_spawned ON pending_enrichments(spawned_at);
    CREATE INDEX IF NOT EXISTS idx_enrichment_queue_status ON enrichment_queue(status);
    CREATE INDEX IF NOT EXISTS idx_enrichment_queue_sec_id ON enrichment_queue(sec_id);
    CREATE INDEX IF NOT EXISTS idx_enrichment_errors_logged_at ON enrichment_errors(logged_at);
  `);

  // Migrations for older local DBs.
  ensureColumn(db, 'advisor_findings', 'agent_name', 'TEXT');
  ensureColumn(db, 'advisor_findings', 'is_trigger_event', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'advisors', 'created_at', 'DATETIME');

  // Drop columns removed in v3.2+ (SQLite >=3.35 supports DROP COLUMN).
  // Safe to call repeatedly — ignores errors if columns don't exist.
  for (const col of ['enrichment_notes', 'agents_processed', 'data_hash']) {
    try {
      db.exec(`ALTER TABLE advisors DROP COLUMN ${col}`);
    } catch (_) { /* column already gone or SQLite version too old — ignore */ }
  }
  for (const col of ['data_hash']) {
    try {
      db.exec(`ALTER TABLE enrichment_queue DROP COLUMN ${col}`);
    } catch (_) { /* column already gone or SQLite version too old — ignore */ }
  }
}

if (require.main === module) {
  const dbExisted = fs.existsSync(dbPath);
  console.log(dbExisted ? '✅ Database already exists, verifying schema...\n' : '📦 Creating advisor database...\n');

  const db = openDb(dbPath);
  try {
    initSchema(db);
    console.log('✅ Table ensured: advisors');
    console.log('✅ Table ensured: advisor_findings');
    console.log('✅ Table ensured: pending_enrichments');
    console.log('✅ Table ensured: enrichment_queue');
    console.log('✅ Table ensured: enrichment_errors');
    console.log('\n✅ Database schema ready at: ' + dbPath);
    console.log('   Use extract-advisors.js to sync SEC data');
  } catch (err) {
    console.error(`❌ Database initialization failed: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

module.exports = { initSchema };
