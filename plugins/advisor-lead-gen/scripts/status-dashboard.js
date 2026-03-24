#!/usr/bin/env node
import fs from "node:fs";

import { openDb, resolveDomainDbPath } from "./db.js";
import { initSchema } from "./db-init.js";
import { initEngineSchema, openEngineDb, resolveEngineDbPath } from "./engine-db.js";

const DEFAULT_DOMAIN_DB_PATH = resolveDomainDbPath();

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { db: DEFAULT_DOMAIN_DB_PATH, format: "json", limit: 10, secId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--db" || a === "--db-path") && args[i + 1]) out.db = args[++i];
    else if (a === "--format" && args[i + 1]) out.format = String(args[++i]).toLowerCase();
    else if ((a === "--limit" || a === "-n") && args[i + 1])
      out.limit = Math.max(1, parseInt(args[++i], 10) || out.limit);
    else if ((a === "--sec-id" || a === "--secid") && args[i + 1]) out.secId = parseInt(args[++i], 10);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function secEntityId(secId) {
  return `advisor:${Number(secId)}`;
}

function secFromEntityId(entityId) {
  const s = String(entityId || "");
  if (!s.startsWith("advisor:")) return null;
  const n = Number(s.slice("advisor:".length));
  return Number.isFinite(n) ? n : null;
}

function buildPayload(opts) {
  const enginePath = resolveEngineDbPath();
  const payload = {
    type: "status_dashboard",
    now: new Date().toISOString(),
    domain_db_path: opts.db,
    engine_db_path: enginePath,
    domain_db_exists: fs.existsSync(opts.db),
    engine_db_exists: fs.existsSync(enginePath),
    queue: { queued: 0, running: 0, done: 0, failed: 0 },
    active_enrichment: null,
    totals: {},
    recent_enriched: [],
    recent_errors: [],
    sec_id_detail: null,
  };

  const domainDb = openDb(opts.db);
  const engineDb = openEngineDb(enginePath);
  try {
    initSchema(domainDb);
    initEngineSchema(engineDb);

    for (const status of ["queued", "running", "done", "failed"]) {
      payload.queue[status] = Number(
        engineDb
          .prepare(
            `SELECT COUNT(*) AS c
             FROM enrichment_jobs
             WHERE pipeline_id='advisors' AND status=?`,
          )
          .get(status)?.c || 0,
      );
    }

    const running = engineDb
      .prepare(
        `SELECT job_id, entity_id, queued_at, started_at
         FROM enrichment_jobs
         WHERE pipeline_id='advisors' AND status='running'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get();
    if (running) {
      const secId = secFromEntityId(running.entity_id);
      const advisor = secId
        ? domainDb
            .prepare(
              `SELECT ap.first_name, ap.last_name, ap.firm_name, ap.city, ap.state
               FROM advisor_profiles ap
               WHERE ap.sec_id=? LIMIT 1`,
            )
            .get(secId)
        : null;
      const specialists = engineDb
        .prepare(
          `SELECT specialist_name, status, spawned_at, completed_at, error
           FROM enrichment_specialist_runs
           WHERE job_id=?
           ORDER BY specialist_name`,
        )
        .all(running.job_id);
      payload.active_enrichment = {
        job_id: running.job_id,
        sec_id: secId,
        name: advisor ? [advisor.first_name, advisor.last_name].filter(Boolean).join(" ") : "",
        firm_name: advisor?.firm_name || "",
        city: advisor?.city || "",
        state: advisor?.state || "",
        queued_at: running.queued_at || null,
        started_at: running.started_at || null,
        specialists_pending: specialists.filter((s) => s.status === "PENDING").length,
        specialists_done: specialists.filter((s) => s.status === "DONE").length,
        specialists_failed: specialists.filter((s) => s.status === "FAILED").length,
        specialists: specialists.map((s) => ({
          specialist: s.specialist_name,
          status: s.status,
          spawned_at: s.spawned_at || null,
          completed_at: s.completed_at || null,
          error: s.error || null,
        })),
      };
    }

    payload.totals.advisors_total = Number(
      domainDb.prepare(`SELECT COUNT(*) AS c FROM advisor_profiles`).get()?.c || 0,
    );
    payload.totals.advisors_enriched = Number(
      domainDb
        .prepare(`SELECT COUNT(*) AS c FROM entities WHERE entity_type='advisor' AND enriched_at IS NOT NULL`)
        .get()?.c || 0,
    );
    payload.totals.advisors_never_enriched = Number(
      domainDb
        .prepare(`SELECT COUNT(*) AS c FROM entities WHERE entity_type='advisor' AND enriched_at IS NULL`)
        .get()?.c || 0,
    );
    payload.totals.advisors_scored = Number(
      domainDb
        .prepare(`SELECT COUNT(*) AS c FROM entities WHERE entity_type='advisor' AND lead_score IS NOT NULL AND lead_score > 0`)
        .get()?.c || 0,
    );

    payload.recent_enriched = domainDb
      .prepare(
        `SELECT ap.sec_id, ap.first_name, ap.last_name, ap.firm_name, ap.city, ap.state,
                e.lead_score, e.enriched_at
         FROM advisor_profiles ap
         JOIN entities e ON e.entity_id = ap.entity_id
         WHERE e.enriched_at IS NOT NULL
         ORDER BY e.enriched_at DESC
         LIMIT ?`,
      )
      .all(opts.limit)
      .map((r) => ({
        sec_id: Number(r.sec_id),
        name: [r.first_name, r.last_name].filter(Boolean).join(" "),
        firm_name: r.firm_name || "",
        city: r.city || "",
        state: r.state || "",
        lead_score: r.lead_score == null ? null : Number(r.lead_score),
        enriched_at: r.enriched_at || null,
      }));

    payload.recent_errors = engineDb
      .prepare(
        `SELECT event_id, job_id, event_type, message, created_at
         FROM enrichment_events
         WHERE event_type IN ('job_failed', 'specialist_failed', 'save_failed', 'spawn_unavailable')
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(opts.limit)
      .map((e) => ({
        id: Number(e.event_id),
        job_id: e.job_id || null,
        event_type: e.event_type,
        message: e.message || "",
        created_at: e.created_at || null,
      }));

    if (Number.isFinite(opts.secId) && opts.secId !== null) {
      const entityId = secEntityId(opts.secId);
      const advisor = domainDb
        .prepare(
          `SELECT ap.sec_id, ap.first_name, ap.last_name, ap.firm_name, ap.city, ap.state,
                  e.lead_score, e.enriched_at, e.updated_at
           FROM advisor_profiles ap
           JOIN entities e ON e.entity_id = ap.entity_id
           WHERE ap.entity_id = ?
           LIMIT 1`,
        )
        .get(entityId);
      const findings = domainDb
        .prepare(
          `SELECT finding_type, finding_value, confidence, source_url, created_at
           FROM findings
           WHERE entity_id=?
           ORDER BY finding_type, created_at`,
        )
        .all(entityId);
      const jobs = engineDb
        .prepare(
          `SELECT job_id, status, queued_at, started_at, completed_at, error
           FROM enrichment_jobs
           WHERE pipeline_id='advisors' AND entity_id=?
           ORDER BY queued_at DESC
           LIMIT 20`,
        )
        .all(entityId);
      payload.sec_id_detail = {
        sec_id: Number(opts.secId),
        advisor: advisor
          ? {
              sec_id: Number(advisor.sec_id),
              name: [advisor.first_name, advisor.last_name].filter(Boolean).join(" "),
              firm_name: advisor.firm_name || "",
              city: advisor.city || "",
              state: advisor.state || "",
              lead_score: advisor.lead_score == null ? null : Number(advisor.lead_score),
              enriched_at: advisor.enriched_at || null,
              updated_at: advisor.updated_at || null,
            }
          : null,
        findings: findings.map((f) => ({
          finding_type: f.finding_type,
          finding_value: f.finding_value,
          confidence: f.confidence,
          source_url: f.source_url || null,
          created_at: f.created_at || null,
        })),
        jobs: jobs.map((j) => ({
          job_id: j.job_id,
          status: j.status,
          queued_at: j.queued_at || null,
          started_at: j.started_at || null,
          completed_at: j.completed_at || null,
          error: j.error || null,
        })),
      };
    }
  } finally {
    domainDb.close();
    engineDb.close();
  }

  return payload;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("## Lead Gen Status Dashboard");
  lines.push(`_${payload.now}_`);
  lines.push("");
  lines.push(`Domain DB: \`${payload.domain_db_path}\``);
  lines.push(`Engine DB: \`${payload.engine_db_path}\``);
  lines.push("");
  lines.push("### Queue");
  lines.push("");
  lines.push(`- queued: ${payload.queue.queued}`);
  lines.push(`- running: ${payload.queue.running}`);
  lines.push(`- done: ${payload.queue.done}`);
  lines.push(`- failed: ${payload.queue.failed}`);
  lines.push("");

  if (payload.active_enrichment) {
    const ae = payload.active_enrichment;
    lines.push(`### Active Enrichment`);
    lines.push("");
    lines.push(`- job: ${ae.job_id}`);
    lines.push(`- advisor: ${ae.sec_id || "unknown"} ${ae.name ? `(${ae.name})` : ""}`);
    lines.push(`- specialists: ${ae.specialists_done} done / ${ae.specialists_pending} pending / ${ae.specialists_failed} failed`);
    lines.push("");
  } else {
    lines.push("### Active Enrichment");
    lines.push("");
    lines.push("No enrichment currently running.");
    lines.push("");
  }

  lines.push("### Advisors");
  lines.push("");
  lines.push(`- total: ${payload.totals.advisors_total || 0}`);
  lines.push(`- enriched: ${payload.totals.advisors_enriched || 0}`);
  lines.push(`- never enriched: ${payload.totals.advisors_never_enriched || 0}`);
  lines.push(`- scored: ${payload.totals.advisors_scored || 0}`);
  lines.push("");
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
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  const payload = buildPayload(opts);
  if (opts.format === "markdown" || opts.format === "md") {
    process.stdout.write(renderMarkdown(payload) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify(
      {
        type: "status_dashboard",
        now: new Date().toISOString(),
        error: "status_dashboard_failed",
        message: err?.message || String(err),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(1);
}
