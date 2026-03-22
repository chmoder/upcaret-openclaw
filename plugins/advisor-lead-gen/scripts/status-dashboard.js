#!/usr/bin/env node
/**
 * status-dashboard.js
 *
 * Prints a single JSON payload (or Markdown) describing the full state of advisors.db:
 *   - Queue counts (queued / running / done / failed)
 *   - Active enrichment with per-specialist breakdown
 *   - Recently enriched advisors
 *   - Recent errors from enrichment_errors log
 *
 * Usage:
 *   node scripts/status-dashboard.js [--format json|markdown] [--limit N] [--sec-id ID] [--db PATH]
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, dbAll as _dbAll } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const DEFAULT_DB_PATH = path.join(ROOT, "advisors.db");

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { db: DEFAULT_DB_PATH, format: "json", limit: 10, secId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--db" || a === "--db-path") && args[i + 1]) out.db = args[++i];
    else if (a === "--format" && args[i + 1])
      out.format = String(args[++i]).toLowerCase();
    else if ((a === "--limit" || a === "-n") && args[i + 1])
      out.limit = Math.max(1, parseInt(args[++i], 10) || out.limit);
    else if ((a === "--sec-id" || a === "--secid") && args[i + 1])
      out.secId = parseInt(args[++i], 10);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

let _db = null;
let _dbPath = null;

function getDb(dbPath) {
  if (!_db || _dbPath !== dbPath) {
    if (_db) {
      try {
        _db.close();
      } catch {}
    }
    _db = openDb(dbPath);
    _dbPath = dbPath;
  }
  return _db;
}

function sqliteAll(dbPath, sql, params = []) {
  const db = getDb(dbPath);
  const stmt = db.prepare(sql);
  return params.length > 0 ? stmt.all(...params) : stmt.all();
}

function sqliteScalar(dbPath, sql, params = []) {
  const rows = sqliteAll(dbPath, sql, params);
  if (!rows || rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  return keys.length > 0 ? rows[0][keys[0]] : null;
}

function hasTable(dbPath, name) {
  return (
    Number(
      sqliteScalar(
        dbPath,
        `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`,
        [name],
      ) || 0,
    ) > 0
  );
}

function buildPayload({ dbPath, limit, secId }) {
  const now = new Date().toISOString();
  const dbExists = fs.existsSync(dbPath);

  const payload = {
    type: "status_dashboard",
    now,
    db_path: dbPath,
    db_exists: dbExists,
    tables: {
      advisors: false,
      advisor_findings: false,
      pending_enrichments: false,
      enrichment_queue: false,
      enrichment_errors: false,
    },
    queue: { queued: 0, running: 0, done: 0, failed: 0 },
    active_enrichment: null,
    totals: {},
    recent_enriched: [],
    recent_errors: [],
    sec_id_detail: null,
  };

  if (!dbExists) return payload;

  for (const t of Object.keys(payload.tables)) {
    payload.tables[t] = hasTable(dbPath, t);
  }

  // --- Queue summary ---
  if (payload.tables.enrichment_queue) {
    for (const status of ["queued", "running", "done", "failed"]) {
      payload.queue[status] = Number(
        sqliteScalar(
          dbPath,
          `SELECT COUNT(*) FROM enrichment_queue WHERE status=?`,
          [status],
        ) || 0,
      );
    }

    // Active enrichment: the running queue row + its specialists
    const running = sqliteAll(
      dbPath,
      `SELECT eq.id, eq.sec_id, eq.queued_at, eq.started_at, a.first_name, a.last_name, a.firm_name, a.city, a.state
       FROM enrichment_queue eq
       LEFT JOIN advisors a ON a.sec_id = eq.sec_id
       WHERE eq.status = 'running'
       ORDER BY eq.started_at DESC
       LIMIT 1`,
    );

    if (running.length > 0) {
      const r = running[0];
      const specialists = payload.tables.pending_enrichments
        ? sqliteAll(
            dbPath,
            `SELECT specialist, status, spawned_at, completed_at, error
             FROM pending_enrichments
             WHERE sec_id = ?
             ORDER BY specialist`,
            [r.sec_id],
          ).map((s) => ({
            specialist: s.specialist,
            status: s.status,
            spawned_at: s.spawned_at || null,
            completed_at: s.completed_at || null,
            error: s.error || null,
          }))
        : [];

      const pendingCount = specialists.filter(
        (s) => s.status === "PENDING",
      ).length;
      const doneCount = specialists.filter((s) => s.status === "DONE").length;
      const failedCount = specialists.filter(
        (s) => s.status === "FAILED",
      ).length;

      payload.active_enrichment = {
        sec_id: Number(r.sec_id),
        name: [r.first_name, r.last_name].filter(Boolean).join(" "),
        firm_name: r.firm_name || "",
        city: r.city || "",
        state: r.state || "",
        queued_at: r.queued_at || null,
        started_at: r.started_at || null,
        specialists_pending: pendingCount,
        specialists_done: doneCount,
        specialists_failed: failedCount,
        specialists,
      };
    }
  }

  // --- Advisor totals ---
  // "pending" = never enriched OR enriched but stale (older than 14 days).
  // enriched_at IS NOT NULL means the advisor has been enriched at least once;
  // stale advisors will be re-enriched automatically by dispatch-cron.js (via enqueue-enrich.js).
  const STALE_DAYS = 14;
  if (payload.tables.advisors) {
    payload.totals.advisors_total = Number(
      sqliteScalar(dbPath, `SELECT COUNT(*) FROM advisors`) || 0,
    );
    payload.totals.advisors_enriched = Number(
      sqliteScalar(
        dbPath,
        `SELECT COUNT(*) FROM advisors WHERE enriched_at IS NOT NULL`,
      ) || 0,
    );
    payload.totals.advisors_never_enriched = Number(
      sqliteScalar(
        dbPath,
        `SELECT COUNT(*) FROM advisors WHERE enriched_at IS NULL`,
      ) || 0,
    );
    payload.totals.advisors_stale = Number(
      sqliteScalar(
        dbPath,
        `SELECT COUNT(*) FROM advisors WHERE enriched_at IS NOT NULL AND enriched_at < datetime('now', '-${STALE_DAYS} days')`,
      ) || 0,
    );
    payload.totals.advisors_scored = Number(
      sqliteScalar(
        dbPath,
        `SELECT COUNT(*) FROM advisors WHERE lead_score IS NOT NULL AND lead_score > 0`,
      ) || 0,
    );
    // pending = need work: never enriched + stale
    payload.totals.advisors_pending =
      payload.totals.advisors_never_enriched + payload.totals.advisors_stale;

    payload.recent_enriched = sqliteAll(
      dbPath,
      `SELECT sec_id, first_name, last_name, firm_name, city, state, lead_score, enriched_at
       FROM advisors
       WHERE enriched_at IS NOT NULL
       ORDER BY enriched_at DESC
       LIMIT ?`,
      [limit],
    ).map((r) => ({
      sec_id: Number(r.sec_id),
      name: [r.first_name, r.last_name].filter(Boolean).join(" "),
      firm_name: r.firm_name || "",
      city: r.city || "",
      state: r.state || "",
      lead_score: r.lead_score == null ? null : Number(r.lead_score),
      enriched_at: r.enriched_at || null,
    }));
  }

  // --- Recent errors ---
  if (payload.tables.enrichment_errors) {
    payload.recent_errors = sqliteAll(
      dbPath,
      `SELECT ee.id, ee.sec_id, ee.specialist, ee.error_type, ee.error_message, ee.logged_at,
              a.first_name, a.last_name
       FROM enrichment_errors ee
       LEFT JOIN advisors a ON a.sec_id = ee.sec_id
       ORDER BY ee.logged_at DESC
       LIMIT ?`,
      [limit],
    ).map((r) => ({
      id: Number(r.id),
      sec_id: r.sec_id ? Number(r.sec_id) : null,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      specialist: r.specialist || null,
      error_type: r.error_type || "",
      error_message: r.error_message || "",
      logged_at: r.logged_at || null,
    }));
  }

  // --- sec_id detail ---
  if (Number.isFinite(secId) && secId !== null) {
    const detail = { sec_id: Number(secId) };

    if (payload.tables.advisors) {
      const a = sqliteAll(
        dbPath,
        `SELECT sec_id, first_name, last_name, firm_name, city, state, lead_score, enriched_at, updated_at
         FROM advisors WHERE sec_id=? LIMIT 1`,
        [secId],
      )[0];
      if (a) {
        detail.advisor = {
          sec_id: Number(a.sec_id),
          name: [a.first_name, a.last_name].filter(Boolean).join(" "),
          firm_name: a.firm_name || "",
          city: a.city || "",
          state: a.state || "",
          lead_score: a.lead_score == null ? null : Number(a.lead_score),
          enriched_at: a.enriched_at || null,
          updated_at: a.updated_at || null,
        };
      }
    }

    if (payload.tables.pending_enrichments) {
      detail.specialists = sqliteAll(
        dbPath,
        `SELECT specialist, status, spawned_at, completed_at, error
         FROM pending_enrichments WHERE sec_id=? ORDER BY specialist`,
        [secId],
      ).map((r) => ({
        specialist: r.specialist || "",
        status: r.status || "",
        spawned_at: r.spawned_at || null,
        completed_at: r.completed_at || null,
        error: r.error || null,
      }));
    }

    if (payload.tables.advisor_findings) {
      detail.findings = sqliteAll(
        dbPath,
        `SELECT finding_type, finding_value, confidence, source_url, created_at
         FROM advisor_findings WHERE sec_id=? ORDER BY finding_type, created_at`,
        [secId],
      ).map((r) => ({
        finding_type: r.finding_type,
        finding_value: r.finding_value,
        confidence: r.confidence,
        source_url: r.source_url || null,
        created_at: r.created_at || null,
      }));
    }

    if (payload.tables.enrichment_errors) {
      detail.errors = sqliteAll(
        dbPath,
        `SELECT id, specialist, error_type, error_message, logged_at
         FROM enrichment_errors WHERE sec_id=? ORDER BY logged_at DESC LIMIT 20`,
        [secId],
      ).map((r) => ({
        id: Number(r.id),
        specialist: r.specialist || null,
        error_type: r.error_type,
        error_message: r.error_message || "",
        logged_at: r.logged_at || null,
      }));
    }

    payload.sec_id_detail = detail;
  }

  return payload;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push(`## Lead Gen Status Dashboard`);
  lines.push(`_${payload.now}_`);
  lines.push("");

  if (!payload.db_exists) {
    lines.push(`> Database not found at \`${payload.db_path}\``);
    return lines.join("\n");
  }

  // Queue
  const q = payload.queue;
  lines.push(`### Queue`);
  lines.push("");
  lines.push(`| status | count |`);
  lines.push(`|--------|------:|`);
  lines.push(`| queued | ${q.queued} |`);
  lines.push(`| running | ${q.running} |`);
  lines.push(`| done | ${q.done} |`);
  lines.push(`| failed | ${q.failed} |`);
  lines.push("");

  // Active enrichment
  if (payload.active_enrichment) {
    const ae = payload.active_enrichment;
    lines.push(
      `### Active Enrichment — ${ae.name || ae.sec_id} (${ae.firm_name || ""}, ${ae.state || ""})`,
    );
    lines.push("");
    lines.push(`Started: ${ae.started_at || "—"}`);
    lines.push(
      `Specialists: ${ae.specialists_done} done · ${ae.specialists_pending} pending · ${ae.specialists_failed} failed`,
    );
    lines.push("");
    if (ae.specialists.length > 0) {
      lines.push(`| specialist | status | spawned | completed |`);
      lines.push(`|------------|--------|---------|-----------|`);
      for (const s of ae.specialists) {
        const status =
          s.status === "DONE"
            ? "✅ DONE"
            : s.status === "FAILED"
              ? "❌ FAILED"
              : "⏳ pending";
        lines.push(
          `| ${s.specialist} | ${status} | ${s.spawned_at || "—"} | ${s.completed_at || "—"} |`,
        );
      }
      lines.push("");
    }
  } else {
    lines.push(`### Active Enrichment`);
    lines.push("");
    lines.push("No enrichment currently running.");
    lines.push("");
  }

  // Advisor totals
  const t = payload.totals || {};
  lines.push(`### Advisors`);
  lines.push("");
  lines.push(`- Total: ${t.advisors_total ?? 0}`);
  lines.push(`- Enriched (ever): ${t.advisors_enriched ?? 0}`);
  lines.push(`- Scored: ${t.advisors_scored ?? 0}`);
  lines.push(`- Never enriched: ${t.advisors_never_enriched ?? 0}`);
  if ((t.advisors_stale ?? 0) > 0) {
    lines.push(`- Stale (>14 days, needs re-enrichment): ${t.advisors_stale}`);
  }
  lines.push(`- Pending work: ${t.advisors_pending ?? 0}`);
  lines.push("");

  // Recently enriched
  if (payload.recent_enriched.length > 0) {
    lines.push(`### Recently Enriched`);
    lines.push("");
    lines.push(`| name | firm | state | score | enriched_at |`);
    lines.push(`|------|------|:-----:|------:|-------------|`);
    for (const r of payload.recent_enriched) {
      lines.push(
        `| ${r.name} | ${r.firm_name} | ${r.state} | ${r.lead_score ?? "—"} | ${r.enriched_at || ""} |`,
      );
    }
    lines.push("");
  }

  // Recent errors
  if (payload.recent_errors.length > 0) {
    lines.push(`### Recent Errors`);
    lines.push("");
    lines.push(`| logged_at | name | specialist | type | message |`);
    lines.push(`|-----------|------|------------|------|---------|`);
    for (const e of payload.recent_errors) {
      const msg = String(e.error_message || "")
        .replace(/\|/g, "\\|")
        .slice(0, 80);
      lines.push(
        `| ${e.logged_at || ""} | ${e.name || e.sec_id || "—"} | ${e.specialist || "—"} | ${e.error_type} | ${msg} |`,
      );
    }
    lines.push("");
  } else {
    lines.push(`### Recent Errors`);
    lines.push("");
    lines.push("No errors logged.");
    lines.push("");
  }

  // sec_id detail
  if (payload.sec_id_detail) {
    const d = payload.sec_id_detail;
    lines.push(`### Detail — sec_id ${d.sec_id}`);
    lines.push("");
    if (d.advisor) {
      const a = d.advisor;
      lines.push(`**${a.name}** · ${a.firm_name} · ${a.city}, ${a.state}`);
      lines.push(`- Lead score: ${a.lead_score ?? "—"}`);
      lines.push(`- Enriched at: ${a.enriched_at || "not yet"}`);
      lines.push("");
    }
    if (d.specialists && d.specialists.length > 0) {
      lines.push(`**Specialists:**`);
      lines.push("");
      lines.push(`| specialist | status | spawned | completed | error |`);
      lines.push(`|------------|--------|---------|-----------|-------|`);
      for (const s of d.specialists) {
        const status =
          s.status === "DONE" ? "✅" : s.status === "FAILED" ? "❌" : "⏳";
        lines.push(
          `| ${s.specialist} | ${status} ${s.status} | ${s.spawned_at || ""} | ${s.completed_at || ""} | ${s.error || ""} |`,
        );
      }
      lines.push("");
    }
    if (d.findings && d.findings.length > 0) {
      lines.push(`**Findings (${d.findings.length}):**`);
      lines.push("");
      lines.push(`| type | value | confidence |`);
      lines.push(`|------|-------|:----------:|`);
      for (const f of d.findings) {
        lines.push(
          `| ${f.finding_type} | ${String(f.finding_value || "").slice(0, 60)} | ${f.confidence} |`,
        );
      }
      lines.push("");
    }
    if (d.errors && d.errors.length > 0) {
      lines.push(`**Errors for this advisor:**`);
      lines.push("");
      for (const e of d.errors) {
        lines.push(
          `- \`${e.error_type}\` ${e.specialist ? `(${e.specialist})` : ""}: ${e.error_message} _(${e.logged_at})_`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    process.stdout.write(
      [
        "Lead Gen status dashboard",
        "",
        "Usage:",
        "  node scripts/status-dashboard.js [--format json|markdown] [--limit N] [--sec-id ID] [--db PATH]",
        "",
        "Examples:",
        "  node scripts/status-dashboard.js",
        "  node scripts/status-dashboard.js --format markdown",
        "  node scripts/status-dashboard.js --sec-id 4100506",
        "  node scripts/status-dashboard.js --format markdown --sec-id 4100506",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  const payload = buildPayload({
    dbPath: opts.db,
    limit: opts.limit,
    secId: opts.secId,
  });

  if (opts.format === "markdown" || opts.format === "md") {
    process.stdout.write(renderMarkdown(payload) + "\n");
    return;
  }

  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

try {
  main();
} catch (err) {
  const out = {
    type: "status_dashboard",
    now: new Date().toISOString(),
    error: "status_dashboard_failed",
    message: err && err.message ? err.message : String(err),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(1);
}
