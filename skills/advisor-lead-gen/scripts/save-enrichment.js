#!/usr/bin/env node

/**
 * save-enrichment.js — Write enrichment results to advisors.db
 *
 * Used by the advisor-enrich orchestrator agent (LLM path) to persist
 * specialist findings + scorer output without needing the sqlite3 CLI.
 *
 * Usage:
 *   node scripts/save-enrichment.js '<json>'
 *
 * JSON input shape:
 *   {
 *     "sec_id": 4167394,
 *     "lead_score": 4,
 *     "score_reason": "...",
 *     "findings": [
 *       { "finding_type": "email", "finding_value": "foo@bar.com", "source_url": "", "confidence": "high" },
 *       ...
 *     ]
 *   }
 *
 * On success, prints:  SAVED:{"sec_id":...,"lead_score":...,"findings_count":...}
 * On error, prints:    ERROR:<message>  and exits with code 1.
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

'use strict';

const path = require('path');
const { openDb, dbRun, dbGet, computeAdvisorHash } = require('./db');

const DB_PATH = path.join(__dirname, '..', 'advisors.db');

function main() {
  // Accept either:
  //   node save-enrichment.js <json-string>
  //   node save-enrichment.js --file <path-to-json-file>
  let raw;
  if (process.argv[2] === '--file') {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error('ERROR: --file requires a path');
      process.exit(1);
    }
    try {
      raw = require('fs').readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`ERROR: cannot read file ${filePath} — ${err.message}`);
      process.exit(1);
    }
  } else {
    raw = process.argv[2];
  }

  if (!raw) {
    console.error('ERROR: no JSON argument provided');
    console.error('Usage:');
    console.error('  node scripts/save-enrichment.js \'{"sec_id":...}\'');
    console.error('  node scripts/save-enrichment.js --file /path/to/result.json');
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: invalid JSON — ${err.message}`);
    process.exit(1);
  }

  const { sec_id, lead_score, score_reason, findings } = payload;

  if (!sec_id) {
    console.error('ERROR: sec_id is required');
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  try {
    // Guard: only accept results for an advisor that is actively running in the queue.
    // If the queue row is missing or was already marked failed/done, refuse to write —
    // this prevents a timed-out (failed) run from being scored when a late result arrives.
    const queueRow = dbGet(db, `SELECT status FROM enrichment_queue WHERE sec_id = ? AND status = 'running'`, [sec_id]);
    if (!queueRow) {
      console.error(`ERROR:no active running queue entry for sec_id ${sec_id} — result discarded (advisor may have timed out or already completed)`);
      process.exit(1);
    }

    // Compute hash of the advisor's current IAPD fields so we can detect future changes.
    const advisorRow = dbGet(db, `SELECT sec_id, first_name, last_name, firm_name, city, state FROM advisors WHERE sec_id = ?`, [sec_id]);
    const dataHash = advisorRow ? computeAdvisorHash(advisorRow) : null;

    // Update advisor row
    dbRun(
      db,
      `UPDATE advisors
       SET enriched_at       = datetime('now'),
           updated_at        = datetime('now'),
           lead_score        = ?,
           lead_score_reason = ?,
           data_hash         = ?,
           validation_status = CASE
             WHEN validation_status IS NULL OR validation_status = 'pending'
             THEN 'enriched'
             ELSE validation_status
           END
       WHERE sec_id = ?`,
      [Number(lead_score) || 0, String(score_reason || ''), dataHash, sec_id]
    );

    // Insert findings
    const insertSql = `
      INSERT OR IGNORE INTO advisor_findings
        (sec_id, finding_type, finding_value, source_url, agent_name, confidence, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, datetime('now'))
    `;

    const insertStmt = db.prepare(insertSql);
    let saved = 0;
    for (const f of Array.isArray(findings) ? findings : []) {
      const value = String(f.finding_value || '').trim();
      if (!value) continue;
      const r = insertStmt.run(
        sec_id,
        String(f.finding_type || 'unknown'),
        value,
        String(f.source_url || ''),
        String(f.agent_name || f.source_name || ''),
        String(f.confidence || 'medium'),
      );
      saved += r.changes; // 0 if deduped by UNIQUE constraint, 1 if inserted
    }

    // Promote best findings back to advisor columns for fast querying / export.
    // "Best" = highest confidence, then most recently inserted. One value per field.
    const PROMOTIONS = [
      { col: 'email',           type: 'email' },
      { col: 'phone',           type: 'phone' },
      { col: 'linkedin_url',    type: 'linkedin_url' },
      { col: 'linkedin_handle', type: 'linkedin_handle' },
      { col: 'firm_website',    type: 'firm_website' },
    ];
    const confRank = { high: 3, medium: 2, low: 1 };
    const promotions = {};
    for (const { col, type } of PROMOTIONS) {
      const row = db.prepare(
        `SELECT finding_value, confidence FROM advisor_findings
         WHERE sec_id = ? AND finding_type = ?
         ORDER BY CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                  created_at DESC LIMIT 1`
      ).get(sec_id, type);
      if (row) promotions[col] = row.finding_value;
    }
    if (Object.keys(promotions).length > 0) {
      const sets = Object.keys(promotions).map(c => `${c} = ?`).join(', ');
      const vals = [...Object.values(promotions), sec_id];
      db.prepare(`UPDATE advisors SET ${sets} WHERE sec_id = ?`).run(...vals);
    }

    // Mark queue row as done
    db.prepare(
      `UPDATE enrichment_queue
       SET status='done', completed_at=datetime('now'), lead_score=?
       WHERE sec_id=? AND status='running'`
    ).run(Number(lead_score) || 0, sec_id);

    const result = { sec_id, lead_score: Number(lead_score) || 0, findings_count: saved, promoted: Object.keys(promotions) };
    console.log(`SAVED:${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}

main();
