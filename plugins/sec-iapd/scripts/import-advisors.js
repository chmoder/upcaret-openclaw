#!/usr/bin/env node

import https from "node:https";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { openDb, resolveEnrichmentDbPath } from "./db.js";

const args = process.argv.slice(2);
let state = "NE";
let limit = 20;
let start = 0;
let output = null;
let debug = false;
let quiet = false;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
SEC IAPD Importer -> enrichment.profiles

Usage:
  node scripts/import-advisors.js [OPTIONS]

Options:
  --state <ST>       Two-letter state code (default: NE)
  --start <N>        Zero-based SEC result offset (default: 0)
  --limit <N>        Maximum advisors to fetch (default: 20)
  --output <file>    Export imported profile rows to JSON file
  --quiet            Suppress per-record logs (cron friendly)
  --debug            Enable debug logs
  --help, -h         Show help
`);
  process.exit(0);
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--state" && args[i + 1]) state = args[++i].toUpperCase();
  if ((args[i] === "--start" || args[i] === "--offset") && args[i + 1])
    start = Number.parseInt(args[++i], 10);
  if (args[i] === "--limit" && args[i + 1]) limit = Number.parseInt(args[++i], 10);
  if (args[i] === "--output" && args[i + 1]) output = args[++i];
  if (args[i] === "--debug") debug = true;
  if (args[i] === "--quiet") quiet = true;
}

if (!Number.isInteger(start) || start < 0) {
  console.error("ERROR: --start must be a non-negative integer");
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1) {
  console.error("ERROR: --limit must be a positive integer");
  process.exit(1);
}

function logLine(message) {
  if (!quiet) console.log(message);
}

function fetchSEC(query) {
  return new Promise((resolve, reject) => {
    const url = `https://api.adviserinfo.sec.gov/search/individual?${query}`;
    if (debug && !quiet) console.log(`[DEBUG] Fetching: ${url}`);

    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`JSON parse failed: ${e.message}`));
            }
          });
        },
      )
      .on("error", reject);
  });
}

function parseAdvisor(doc) {
  const source = doc?._source || {};
  const firstName = source.ind_firstname || "";
  const lastName = source.ind_lastname || "";
  const employments = source.ind_ia_current_employments || [];
  const iaEmployments = employments.filter((e) => e.ia_only === "Y");
  if (iaEmployments.length === 0 || !firstName || !lastName) return null;
  const primary = iaEmployments[0];

  return {
    sec_id: Number.parseInt(source.ind_source_id, 10),
    first_name: firstName,
    middle_name: source.ind_middlename || "",
    last_name: lastName,
    display_name: [firstName, lastName].filter(Boolean).join(" "),
    current_employer: primary.firm_name || "",
    current_title: "Financial Advisor",
    location_city: primary.branch_city || "",
    location_state: primary.branch_state || "",
    source_data: {
      alternate_names: source.ind_other_names || [],
      firm_id: primary.firm_id || null,
      firm_name: primary.firm_name || "",
      branch_zip: primary.branch_zip || "",
      registration_status: source.ind_ia_scope || "Unknown",
      investment_advisor_only: source.ind_ia_scope === "Active" ? 1 : 0,
      disclosure_flag: source.ind_ia_disclosure_fl || "N",
      finra_registration_count: source.ind_approved_finra_registration_count || 0,
      employment_count: source.ind_employments_count || 1,
      last_updated_iapd: source.ind_industry_cal_date_iapd || null,
      raw_employment_data: iaEmployments,
    },
  };
}

function ensureProfilesSchema(db) {
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
    CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_source_key
      ON profiles(source_system, source_key);
  `);
}

function upsertProfile(db, advisor) {
  const sourceSystem = "sec_iapd";
  const sourceKey = String(advisor.sec_id);
  const existingBySource = db
    .prepare(
      `SELECT profile_id
       FROM profiles
       WHERE source_system = ? AND source_key = ?
       LIMIT 1`,
    )
    .get(sourceSystem, sourceKey);
  const profileId = existingBySource?.profile_id || randomUUID();

  db.prepare(
    `INSERT INTO profiles (
      profile_id, first_name, last_name, middle_name, display_name,
      location_city, location_state, location_country,
      current_employer, current_title,
      source_system, source_key, source_data, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, 'US',
      ?, ?,
      ?, ?, ?, datetime('now')
    )
    ON CONFLICT(profile_id) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      middle_name = excluded.middle_name,
      display_name = excluded.display_name,
      location_city = excluded.location_city,
      location_state = excluded.location_state,
      current_employer = excluded.current_employer,
      current_title = excluded.current_title,
      source_system = excluded.source_system,
      source_key = excluded.source_key,
      source_data = excluded.source_data,
      updated_at = datetime('now')`,
  ).run(
    profileId,
    advisor.first_name,
    advisor.last_name,
    advisor.middle_name,
    advisor.display_name,
    advisor.location_city,
    advisor.location_state,
    advisor.current_employer,
    advisor.current_title,
    sourceSystem,
    sourceKey,
    JSON.stringify(advisor.source_data),
  );

  return existingBySource ? "updated" : "inserted";
}

(async () => {
  const dbPath = resolveEnrichmentDbPath();
  const db = openDb(dbPath);
  try {
    ensureProfilesSchema(db);
    logLine(`SEC IAPD import -> ${dbPath}`);
    logLine(`State=${state} Start=${start} Limit=${limit}`);

    const docs = [];
    let totalFound = 0;
    let remaining = limit;
    let pageStart = start;

    while (remaining > 0) {
      const pageSize = Math.min(remaining, 100);
      const query = `state=${state}&filter=active=true,ia=true&includePrevious=true&hl=true&nrows=${pageSize}&start=${pageStart}&sort=score+desc&wt=json`;
      const response = await fetchSEC(query);
      if (response?.errorCode) {
        throw new Error(
          `SEC API error ${response.errorCode}: ${response.errorMessage || "Unknown error"}`,
        );
      }
      if (!totalFound) totalFound = response?.hits?.total || 0;
      const pageDocs = response?.hits?.hits || [];
      docs.push(...pageDocs);
      if (pageDocs.length === 0 || pageDocs.length < pageSize) break;
      remaining -= pageDocs.length;
      pageStart += pageDocs.length;
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const doc of docs) {
      const advisor = parseAdvisor(doc);
      if (!advisor || !Number.isFinite(advisor.sec_id)) {
        skipped++;
        continue;
      }
      const action = upsertProfile(db, advisor);
      if (action === "inserted") {
        inserted++;
        logLine(`NEW:${advisor.sec_id}:${advisor.display_name}`);
      } else {
        updated++;
        logLine(`UPDATED:${advisor.sec_id}:${advisor.display_name}`);
      }
    }

    if (output) {
      const rows = db
        .prepare(
          `SELECT profile_id, first_name, last_name, current_employer, location_city, location_state,
                  source_system, source_key, updated_at
           FROM profiles
           WHERE source_system = 'sec_iapd'
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(limit);
      fs.writeFileSync(output, JSON.stringify(rows, null, 2));
    }

    const summary = {
      inserted,
      updated,
      skipped,
      total: inserted + updated + skipped,
      requested_limit: limit,
      fetched_docs: docs.length,
      total_found_in_state: totalFound,
      state,
      start,
      db_path: dbPath,
      exit_code: 0,
    };
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: String(error?.message || error),
        state,
        start,
        limit,
        exit_code: 1,
      }),
    );
    process.exit(1);
  } finally {
    db.close();
  }
})();
