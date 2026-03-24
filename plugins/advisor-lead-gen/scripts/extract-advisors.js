#!/usr/bin/env node

/**
 * SEC IAPD Financial Advisor Extractor with Database Sync
 * Queries SEC API, compares with DB, inserts new or updates existing records
 *
 * Usage:
 *   node extract-advisors.js --state NE --limit 50
 *   node extract-advisors.js --state CA --start 100 --limit 200 --output report.json
 */

import https from "node:https";
import fs from "node:fs";

import { dbAll, dbGet as _dbGet, dbRun, openDb, resolveDomainDbPath } from "./db.js";
import { initSchema } from "./db-init.js";

// Parse command-line arguments
const args = process.argv.slice(2);
let state = 'NE';
let limit = 20;
let start = 0;
let output = null;
let debug = false;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🕷️  SEC IAPD Advisor Extractor + Database Sync

Usage:
  node extract-advisors.js [OPTIONS]

Options:
  --state <ST>       Two-letter state code (default: NE)
  --start <N>        Zero-based SEC result offset (default: 0)
  --limit <N>        Maximum advisors to fetch (default: 20)
  --output <file>    Export results to JSON file (optional)
  --debug            Enable debug logging
  --help, -h         Show this help message

Examples:
  node extract-advisors.js --state CA --limit 100
  node extract-advisors.js --state NE --start 100 --limit 50 --output report.json
  node extract-advisors.js --debug
`);
  process.exit(0);
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state' && args[i + 1]) state = args[++i].toUpperCase();
  if ((args[i] === '--start' || args[i] === '--offset') && args[i + 1]) start = parseInt(args[++i], 10);
  if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
  if (args[i] === '--output' && args[i + 1]) output = args[++i];
  if (args[i] === '--debug') debug = true;
}

if (!Number.isInteger(start) || start < 0) {
  console.error('❌ Error: --start must be a non-negative integer');
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1) {
  console.error('❌ Error: --limit must be a positive integer');
  process.exit(1);
}

const dbPath = resolveDomainDbPath();

// Open a single DB connection for the lifetime of this process run.
const _db = openDb();

function dbAllLocal(sql, params = []) {
  return dbAll(_db, sql, params);
}

function dbGetLocal(sql, params = []) {
  return _dbGet(_db, sql, params);
}

function dbRunLocal(sql, params = []) {
  return dbRun(_db, sql, params);
}

/**
 * Fetch data from SEC IAPD API
 */
function fetchSEC(query) {
  return new Promise((resolve, reject) => {
    const url = `https://api.adviserinfo.sec.gov/search/individual?${query}`;
    
    if (debug) console.log(`[DEBUG] Fetching: ${url}`);
    
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function ensureDbSchema() {
  initSchema(_db);
}

function toEntityId(secId) {
  return `advisor:${Number(secId)}`;
}

function upsertAdvisorSECFields(advisor) {
  const entityId = toEntityId(advisor.sec_id);
  const displayName = [advisor.first_name, advisor.last_name].filter(Boolean).join(" ");
  dbRunLocal(
    `
    INSERT INTO entities (
      entity_id, entity_type, display_name, source_system, source_key, updated_at
    ) VALUES (
      ?, 'advisor', ?, 'sec_iapd', ?, datetime('now')
    )
    ON CONFLICT(entity_id) DO UPDATE SET
      display_name = excluded.display_name,
      source_system = excluded.source_system,
      source_key = excluded.source_key,
      updated_at = datetime('now');
    `,
    [entityId, displayName, String(advisor.sec_id)],
  );

  // Upsert SEC-sourced fields into advisor-specific extension table.
  dbRunLocal(
    `
    INSERT INTO advisor_profiles (
      entity_id, sec_id, first_name, middle_name, last_name, alternate_names,
      firm_id, firm_name, city, state, zip,
      registration_status, investment_advisor_only, disclosure_flag,
      finra_registration_count, employment_count,
      last_updated_iapd, raw_employment_data,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      datetime('now')
    )
    ON CONFLICT(entity_id) DO UPDATE SET
      sec_id = excluded.sec_id,
      first_name = excluded.first_name,
      middle_name = excluded.middle_name,
      last_name = excluded.last_name,
      alternate_names = excluded.alternate_names,
      firm_id = excluded.firm_id,
      firm_name = excluded.firm_name,
      city = excluded.city,
      state = excluded.state,
      zip = excluded.zip,
      registration_status = excluded.registration_status,
      investment_advisor_only = excluded.investment_advisor_only,
      disclosure_flag = excluded.disclosure_flag,
      finra_registration_count = excluded.finra_registration_count,
      employment_count = excluded.employment_count,
      last_updated_iapd = excluded.last_updated_iapd,
      raw_employment_data = excluded.raw_employment_data,
      updated_at = datetime('now');
    `,
    [
      entityId,
      advisor.sec_id,
      advisor.first_name,
      advisor.middle_name,
      advisor.last_name,
      advisor.alternate_names,
      advisor.firm_id,
      advisor.firm_name,
      advisor.city,
      advisor.state,
      advisor.zip,
      advisor.registration_status,
      advisor.investment_advisor_only,
      advisor.disclosure_flag,
      advisor.finra_registration_count,
      advisor.employment_count,
      advisor.last_updated_iapd,
      advisor.raw_employment_data
    ]
  );
}

/**
 * Parse SEC API response into advisor object
 */
function parseAdvisor(doc) {
  const source = doc._source || {};
  const firstName = source.ind_firstname || '';
  const lastName = source.ind_lastname || '';
  
  // Get Investment Advisor employments only (ia_only = Y)
  const employments = source.ind_ia_current_employments || [];
  const iaEmployments = employments.filter(e => e.ia_only === 'Y');
  
  if (iaEmployments.length === 0 || !firstName || !lastName) {
    return null;
  }
  
  const primary = iaEmployments[0];
  
  return {
    sec_id: parseInt(source.ind_source_id, 10),
    first_name: firstName,
    middle_name: source.ind_middlename || '',
    last_name: lastName,
    alternate_names: (source.ind_other_names || []).join('; '),
    firm_id: primary.firm_id || null,
    firm_name: primary.firm_name || '',
    city: primary.branch_city || '',
    state: primary.branch_state || '',
    zip: primary.branch_zip || '',
    registration_status: source.ind_ia_scope || 'Unknown',
    investment_advisor_only: source.ind_ia_scope === 'Active' ? 1 : 0,
    disclosure_flag: source.ind_ia_disclosure_fl || 'N',
    finra_registration_count: source.ind_approved_finra_registration_count || 0,
    employment_count: source.ind_employments_count || 1,
    last_updated_iapd: source.ind_industry_cal_date_iapd || null,
    raw_employment_data: JSON.stringify(iaEmployments)
  };
}

/**
 * Main
 */
(async () => {
  try {
    console.log(`🕷️  SEC IAPD Advisor Extractor + Database Sync`);
    console.log(`📍 State: ${state}`);
    console.log(`⏩ Start offset: ${start}`);
    console.log(`📊 Limit: ${limit}\n`);
    
    console.log(`📦 Ensuring database schema...`);
    await ensureDbSchema();
    
    // Fetch paginated data from SEC API (max nrows=100 per request)
    console.log(`📡 Fetching from SEC API...\n`);
    const docs = [];
    let totalFound = 0;
    let remaining = limit;
    let pageStart = start;

    while (remaining > 0) {
      const pageSize = Math.min(remaining, 100);
      const query = `state=${state}&filter=active=true,ia=true&includePrevious=true&hl=true&nrows=${pageSize}&start=${pageStart}&sort=score+desc&wt=json`;
      const response = await fetchSEC(query);

      if (response?.errorCode) {
        throw new Error(`SEC API error ${response.errorCode}: ${response.errorMessage || 'Unknown error'}`);
      }

      if (!totalFound) {
        totalFound = response.hits?.total || 0;
      }

      const pageDocs = response.hits?.hits || [];
      docs.push(...pageDocs);

      if (debug) {
        console.log(`[DEBUG] Page start=${pageStart} size=${pageSize} returned=${pageDocs.length}`);
      }

      // Stop if no more records (or we've reached the end of available results)
      if (pageDocs.length === 0 || pageDocs.length < pageSize) break;

      remaining -= pageDocs.length;
      pageStart += pageDocs.length;
    }
    
    console.log(`✅ API Response received`);
    console.log(`   Total advisors in ${state}: ${totalFound}`);
    console.log(`   Results fetched: ${docs.length} (from offset ${start})\n`);
    
    // Process each advisor
    const results = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    
    console.log(`🔄 Syncing with database...\n`);
    
    for (const doc of docs) {
      const advisor = parseAdvisor(doc);
      if (!advisor) {
        skipped++;
        continue;
      }
      
      const existing = dbGetLocal(
        "SELECT sec_id FROM advisor_profiles WHERE sec_id = ?",
        [advisor.sec_id],
      );
      upsertAdvisorSECFields(advisor);

      if (existing) {
        updated++;
        results.push({ action: 'updated', sec_id: advisor.sec_id });
        console.log(`  📝 UPDATE: ${advisor.first_name} ${advisor.last_name} (${advisor.firm_name})`);
      } else {
        inserted++;
        results.push({ action: 'inserted', sec_id: advisor.sec_id });
        console.log(`  ✨ NEW: ${advisor.first_name} ${advisor.last_name} (${advisor.firm_name})`);
      }
    }
    
    // Summary
    console.log(`\n✅ Database Sync Complete`);
    console.log(`   ✨ New advisors: ${inserted}`);
    console.log(`   📝 Updated: ${updated}`);
    console.log(`   ⏭️  Skipped (not IA): ${skipped}`);
    console.log(`   Total processed: ${inserted + updated + skipped}\n`);
    
    // Export JSON if requested
    if (output) {
      const rows = dbAllLocal(
        `SELECT ap.*, e.enriched_at, e.lead_score, e.lead_score_reason
         FROM advisor_profiles ap
         LEFT JOIN entities e ON e.entity_id = ap.entity_id
         ORDER BY ap.updated_at DESC
         LIMIT ?`,
        [limit],
      );
      fs.writeFileSync(output, JSON.stringify(rows, null, 2));
      console.log(`📄 Exported to: ${output}`);
    } else {
      console.log(`📦 Database: ${dbPath}`);
    }
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    if (debug) console.error(error.stack);
    process.exit(1);
  } finally {
    _db.close();
  }
})();
