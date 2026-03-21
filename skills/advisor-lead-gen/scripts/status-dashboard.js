#!/usr/bin/env node
/**
 * status-dashboard.js
 *
 * Prints a single JSON payload describing advisors.db status:
 * - Active enrichment runs (pending specialists)
 * - Recent enriched advisors
 * - Recent failed specialists
 *
 * This is intended to be called by a chat agent, which renders the JSON into Markdown.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'advisors.db');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    db: DEFAULT_DB_PATH,
    format: 'json', // json | markdown
    limit: 10,
    secId: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--db' || a === '--db-path') && args[i + 1]) out.db = args[++i];
    else if (a === '--format' && args[i + 1]) out.format = String(args[++i]).toLowerCase();
    else if ((a === '--limit' || a === '-n') && args[i + 1]) out.limit = Math.max(1, parseInt(args[++i], 10) || out.limit);
    else if ((a === '--sec-id' || a === '--secid') && args[i + 1]) out.secId = parseInt(args[++i], 10);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function sqliteJson(dbPath, sql, params = []) {
  let bound = String(sql);
  for (const p of params) {
    const lit =
      p === null || p === undefined ? 'NULL' :
        (typeof p === 'number' && Number.isFinite(p)) ? String(p) :
          `'${String(p).replace(/'/g, "''")}'`;
    bound = bound.replace('?', lit);
  }

  const out = execFileSync('sqlite3', ['-json', dbPath, bound], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const trimmed = (out || '').trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return [];
  }
}

function sqliteScalar(dbPath, sql, params = []) {
  const rows = sqliteJson(dbPath, sql, params);
  if (!rows || rows.length === 0) return null;
  const first = rows[0];
  const keys = Object.keys(first);
  return keys.length > 0 ? first[keys[0]] : null;
}

function hasTable(dbPath, tableName) {
  const n = sqliteScalar(
    dbPath,
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`,
    [tableName]
  );
  return Number(n || 0) > 0;
}

function buildPayload({ dbPath, limit, secId }) {
  const now = new Date().toISOString();
  const dbExists = fs.existsSync(dbPath);

  const payload = {
    type: 'status_dashboard',
    now,
    db_path: dbPath,
    db_exists: dbExists,
    tables: {
      advisors: false,
      advisor_findings: false,
      pending_enrichments: false,
    },
    totals: {},
    active_runs: [],
    recent_enriched: [],
    recent_failed: [],
    sec_id_detail: null,
  };

  if (!dbExists) return payload;

  payload.tables.advisors = hasTable(dbPath, 'advisors');
  payload.tables.advisor_findings = hasTable(dbPath, 'advisor_findings');
  payload.tables.pending_enrichments = hasTable(dbPath, 'pending_enrichments');

  if (payload.tables.advisors) {
    payload.totals.advisors_total = Number(sqliteScalar(dbPath, `SELECT COUNT(*) AS c FROM advisors`) || 0);
    payload.totals.advisors_enriched = Number(sqliteScalar(dbPath, `SELECT COUNT(*) AS c FROM advisors WHERE enriched_at IS NOT NULL`) || 0);
    payload.totals.advisors_scored = Number(sqliteScalar(dbPath, `SELECT COUNT(*) AS c FROM advisors WHERE lead_score IS NOT NULL AND lead_score > 0`) || 0);

    payload.recent_enriched = sqliteJson(
      dbPath,
      `
      SELECT
        sec_id,
        first_name,
        last_name,
        firm_name,
        city,
        state,
        lead_score,
        enriched_at
      FROM advisors
      WHERE enriched_at IS NOT NULL
      ORDER BY enriched_at DESC
      LIMIT ?;
      `,
      [limit]
    ).map((r) => ({
      sec_id: Number(r.sec_id),
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      firm_name: r.firm_name || '',
      city: r.city || '',
      state: r.state || '',
      lead_score: r.lead_score === null || r.lead_score === undefined ? null : Number(r.lead_score),
      enriched_at: r.enriched_at || null,
    }));
  }

  if (payload.tables.pending_enrichments) {
    payload.totals.pending_rows = Number(sqliteScalar(dbPath, `SELECT COUNT(*) AS c FROM pending_enrichments WHERE status='PENDING'`) || 0);
    payload.totals.failed_rows = Number(sqliteScalar(dbPath, `SELECT COUNT(*) AS c FROM pending_enrichments WHERE status='FAILED'`) || 0);
    payload.totals.pending_sec_ids = Number(sqliteScalar(dbPath, `SELECT COUNT(DISTINCT sec_id) AS c FROM pending_enrichments WHERE status='PENDING'`) || 0);

    const active = sqliteJson(
      dbPath,
      `
      WITH per AS (
        SELECT
          sec_id,
          MIN(spawned_at) AS started_at,
          MAX(COALESCE(completed_at, spawned_at)) AS last_activity_at,
          SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) AS done_count,
          SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed_count
        FROM pending_enrichments
        GROUP BY sec_id
      )
      SELECT *
      FROM per
      WHERE pending_count > 0
      ORDER BY last_activity_at DESC
      LIMIT ?;
      `,
      [limit]
    );

    // Optional join to advisors for names.
    let advisorBySec = {};
    if (payload.tables.advisors && active.length > 0) {
      const secIds = active.map((r) => Number(r.sec_id)).filter((n) => Number.isFinite(n));
      const list = secIds.join(',');
      if (list.length > 0) {
        const rows = sqliteJson(
          dbPath,
          `
          SELECT sec_id, first_name, last_name, firm_name, city, state
          FROM advisors
          WHERE sec_id IN (${list});
          `
        );
        for (const r of rows) {
          advisorBySec[Number(r.sec_id)] = {
            name: [r.first_name, r.last_name].filter(Boolean).join(' '),
            firm_name: r.firm_name || '',
            city: r.city || '',
            state: r.state || '',
          };
        }
      }
    }

    payload.active_runs = active.map((r) => {
      const sec = Number(r.sec_id);
      const advisor = advisorBySec[sec] || {};
      return {
        sec_id: sec,
        name: advisor.name || '',
        firm_name: advisor.firm_name || '',
        city: advisor.city || '',
        state: advisor.state || '',
        started_at: r.started_at || null,
        last_activity_at: r.last_activity_at || null,
        pending_count: Number(r.pending_count || 0),
        done_count: Number(r.done_count || 0),
        failed_count: Number(r.failed_count || 0),
      };
    });

    payload.recent_failed = sqliteJson(
      dbPath,
      `
      SELECT sec_id, specialist, error, completed_at
      FROM pending_enrichments
      WHERE status='FAILED'
      ORDER BY COALESCE(completed_at, spawned_at) DESC
      LIMIT ?;
      `,
      [limit]
    ).map((r) => ({
      sec_id: Number(r.sec_id),
      specialist: r.specialist || '',
      error: r.error || '',
      completed_at: r.completed_at || null,
    }));
  }

  if (Number.isFinite(secId) && secId !== null) {
    const detail = { sec_id: Number(secId) };
    if (payload.tables.advisors) {
      const a = sqliteJson(
        dbPath,
        `
        SELECT sec_id, first_name, last_name, firm_name, city, state, lead_score, enriched_at, updated_at
        FROM advisors
        WHERE sec_id = ?
        LIMIT 1;
        `,
        [secId]
      )[0];
      if (a) {
        detail.advisor = {
          sec_id: Number(a.sec_id),
          name: [a.first_name, a.last_name].filter(Boolean).join(' '),
          firm_name: a.firm_name || '',
          city: a.city || '',
          state: a.state || '',
          lead_score: a.lead_score === null || a.lead_score === undefined ? null : Number(a.lead_score),
          enriched_at: a.enriched_at || null,
          updated_at: a.updated_at || null,
        };
      }
    }
    if (payload.tables.pending_enrichments) {
      detail.specialists = sqliteJson(
        dbPath,
        `
        SELECT specialist, status, spawned_at, completed_at, error
        FROM pending_enrichments
        WHERE sec_id = ?
        ORDER BY specialist;
        `,
        [secId]
      ).map((r) => ({
        specialist: r.specialist || '',
        status: r.status || '',
        spawned_at: r.spawned_at || null,
        completed_at: r.completed_at || null,
        error: r.error || null,
      }));
    }
    payload.sec_id_detail = detail;
  }

  return payload;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push(`## Lead Gen Status Dashboard`);
  lines.push('');
  lines.push(`- **Now**: ${payload.now}`);
  lines.push(`- **DB**: \`${payload.db_path}\` (${payload.db_exists ? 'present' : 'missing'})`);
  lines.push('');

  if (!payload.db_exists) return lines.join('\n');

  lines.push(`### Totals`);
  lines.push('');
  const t = payload.totals || {};
  lines.push(`- advisors_total: ${t.advisors_total ?? 0}`);
  lines.push(`- advisors_enriched: ${t.advisors_enriched ?? 0}`);
  lines.push(`- advisors_scored: ${t.advisors_scored ?? 0}`);
  lines.push(`- pending_rows: ${t.pending_rows ?? 0}`);
  lines.push(`- pending_sec_ids: ${t.pending_sec_ids ?? 0}`);
  lines.push(`- failed_rows: ${t.failed_rows ?? 0}`);
  lines.push('');

  if (payload.active_runs && payload.active_runs.length > 0) {
    lines.push(`### Active Runs (in progress)`);
    lines.push('');
    lines.push(`| sec_id | name | firm | state | pending | done | failed | last_activity_at |`);
    lines.push(`|---:|---|---|:--:|---:|---:|---:|---|`);
    for (const r of payload.active_runs) {
      lines.push(`| ${r.sec_id} | ${r.name || ''} | ${r.firm_name || ''} | ${r.state || ''} | ${r.pending_count} | ${r.done_count} | ${r.failed_count} | ${r.last_activity_at || ''} |`);
    }
    lines.push('');
  }

  if (payload.recent_enriched && payload.recent_enriched.length > 0) {
    lines.push(`### Recently Enriched`);
    lines.push('');
    lines.push(`| sec_id | name | firm | state | score | enriched_at |`);
    lines.push(`|---:|---|---|:--:|---:|---|`);
    for (const r of payload.recent_enriched) {
      lines.push(`| ${r.sec_id} | ${r.name || ''} | ${r.firm_name || ''} | ${r.state || ''} | ${r.lead_score ?? ''} | ${r.enriched_at || ''} |`);
    }
    lines.push('');
  }

  if (payload.recent_failed && payload.recent_failed.length > 0) {
    lines.push(`### Recent Failures`);
    lines.push('');
    lines.push(`| sec_id | specialist | completed_at | error |`);
    lines.push(`|---:|---|---|---|`);
    for (const r of payload.recent_failed) {
      lines.push(`| ${r.sec_id} | ${r.specialist || ''} | ${r.completed_at || ''} | ${String(r.error || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  if (payload.sec_id_detail) {
    lines.push(`### sec_id Detail: ${payload.sec_id_detail.sec_id}`);
    lines.push('');
    if (payload.sec_id_detail.advisor) {
      const a = payload.sec_id_detail.advisor;
      lines.push(`- **Advisor**: ${a.name || ''} (${a.state || ''}) — ${a.firm_name || ''}`);
      if (a.enriched_at) lines.push(`- **Enriched at**: ${a.enriched_at}`);
      if (a.lead_score !== null && a.lead_score !== undefined) lines.push(`- **Lead score**: ${a.lead_score}`);
      lines.push('');
    }
    if (payload.sec_id_detail.specialists && payload.sec_id_detail.specialists.length > 0) {
      lines.push(`| specialist | status | spawned_at | completed_at | error |`);
      lines.push(`|---|---|---|---|---|`);
      for (const s of payload.sec_id_detail.specialists) {
        lines.push(`| ${s.specialist} | ${s.status} | ${s.spawned_at || ''} | ${s.completed_at || ''} | ${String(s.error || '').replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    const help = [
      'Lead Gen status dashboard',
      '',
      'Usage:',
      '  node scripts/status-dashboard.js [--format json|markdown] [--limit N] [--sec-id ID] [--db PATH]',
      '',
      'Examples:',
      '  node scripts/status-dashboard.js',
      '  node scripts/status-dashboard.js --format markdown',
      '  node scripts/status-dashboard.js --sec-id 4167394',
    ].join('\n');
    process.stdout.write(help + '\n');
    process.exit(0);
  }

  const payload = buildPayload({ dbPath: opts.db, limit: opts.limit, secId: opts.secId });

  if (opts.format === 'markdown' || opts.format === 'md') {
    process.stdout.write(renderMarkdown(payload) + '\n');
    return;
  }

  // Default: JSON for agent consumption.
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  const out = {
    type: 'status_dashboard',
    now: new Date().toISOString(),
    error: 'status_dashboard_failed',
    message: err && err.message ? err.message : String(err),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(1);
}

