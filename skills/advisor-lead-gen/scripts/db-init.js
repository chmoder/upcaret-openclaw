#!/usr/bin/env node

/**
 * SEC IAPD Advisor Database Initialization
 * Ensures SQLite database schema for advisors/findings is present.
 * Safe to run repeatedly (idempotent).
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const dbPath = path.join(__dirname, '../advisors.db');
const dbExisted = fs.existsSync(dbPath);

function runSql(sql) {
  execFileSync('sqlite3', [dbPath, sql], { stdio: 'pipe' });
}

function queryJson(sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { stdio: 'pipe', encoding: 'utf8' });
  const trimmed = (out || '').trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function ensureColumn(table, column, definition) {
  const cols = queryJson(`PRAGMA table_info(${table});`).map((c) => c.name);
  if (!cols.includes(column)) {
    runSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    console.log(`✅ Column added: ${table}.${column}`);
  }
}

try {
  console.log(dbExisted ? '✅ Database already exists, verifying schema...\n' : '📦 Creating advisor database...\n');

  runSql(`
    CREATE TABLE IF NOT EXISTS advisors (
      -- SEC Identification
      sec_id INTEGER PRIMARY KEY,
      
      -- Personal Information (from SEC API)
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      alternate_names TEXT,
      
      -- Current Employment (from SEC API)
      firm_id INTEGER,
      firm_name TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      
      -- Registration Status (from SEC API)
      registration_status TEXT,
      investment_advisor_only INTEGER,
      disclosure_flag TEXT,
      finra_registration_count INTEGER,
      employment_count INTEGER,
      
      -- SEC Metadata (from SEC API)
      last_updated_iapd TEXT,
      raw_employment_data TEXT,
      
      -- Enrichment Fields (from external sources - preserved on updates)
      email TEXT,
      phone TEXT,
      firm_website TEXT,
      linkedin_url TEXT,
      linkedin_handle TEXT,
      enrichment_notes TEXT,
      
      -- Lead Scoring (0-5, assigned by Lead Scorer Agent)
      lead_score INTEGER DEFAULT 0,
      lead_score_reason TEXT,
      
      -- Validation & Enrichment Status
      validation_status TEXT DEFAULT 'pending',
      
      -- Agent Processing Status (JSON: {"agent_name": timestamp, ...})
      agents_processed TEXT,
      
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      enriched_at DATETIME
    )
  `);
  console.log('✅ Table ensured: advisors');
  
  runSql(`
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
      FOREIGN KEY(sec_id) REFERENCES advisors(sec_id)
    )
  `);
  console.log('✅ Table ensured: advisor_findings');

  runSql(`
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
    )
  `);
  console.log('✅ Table ensured: pending_enrichments');

  runSql(`CREATE INDEX IF NOT EXISTS idx_advisors_enriched_at ON advisors(enriched_at)`);
  runSql(`CREATE INDEX IF NOT EXISTS idx_findings_sec_type ON advisor_findings(sec_id, finding_type)`);
  runSql(`CREATE INDEX IF NOT EXISTS idx_pending_enrichments_status ON pending_enrichments(status)`);
  runSql(`CREATE INDEX IF NOT EXISTS idx_pending_enrichments_spawned ON pending_enrichments(spawned_at)`);
  runSql(`PRAGMA foreign_keys = ON`);

  // Migrations for older local DBs.
  ensureColumn('advisor_findings', 'agent_name', 'TEXT');
  ensureColumn('advisor_findings', 'is_trigger_event', 'INTEGER DEFAULT 0');
  ensureColumn('advisors', 'created_at', 'DATETIME');

  console.log('\n✅ Database schema ready at: ' + dbPath);
  console.log('   Use extract-advisors.js to sync SEC data');
} catch (err) {
  console.error(`❌ Database initialization failed: ${err.message}`);
  process.exit(1);
}
