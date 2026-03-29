#!/usr/bin/env node

import fs from "node:fs";
import { openDb, resolveEnrichmentDbPath } from "./db.js";
import { initSchema } from "./db-init.js";

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { format: "json", limit: 10, profileId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format" && args[i + 1]) out.format = String(args[++i]).toLowerCase();
    else if ((a === "--limit" || a === "-n") && args[i + 1])
      out.limit = Math.max(1, Number.parseInt(args[++i], 10) || out.limit);
    else if (a === "--profile-id" && args[i + 1]) out.profileId = String(args[++i]).trim();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function buildPayload(opts) {
  const dbPath = resolveEnrichmentDbPath();
  const payload = {
    type: "status_dashboard",
    now: new Date().toISOString(),
    db_path: dbPath,
    db_exists: fs.existsSync(dbPath),
    queue: { queued: 0, running: 0, done: 0, failed: 0 },
    active_enrichment: null,
    last_completed: null,
    totals: {},
    recent_enriched: [],
    recent_errors: [],
    profile_detail: null,
  };

  const db = openDb(dbPath);
  try {
    initSchema(db);

    for (const status of ["queued", "running", "done", "failed"]) {
      payload.queue[status] = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c
             FROM enrichment_jobs
             WHERE status = ?`,
          )
          .get(status)?.c || 0,
      );
    }

    const running = db
      .prepare(
        `SELECT job_id, profile_id, queued_at, started_at
         FROM enrichment_jobs
         WHERE status='running'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get();
    if (running) {
      const profile = db
        .prepare(
          `SELECT display_name, first_name, last_name, current_employer, current_title
           FROM profiles
           WHERE profile_id = ?`,
        )
        .get(running.profile_id);
      const specialists = db
        .prepare(
          `SELECT specialist_name, status
           FROM enrichment_specialist_runs
           WHERE job_id = ?
           ORDER BY specialist_name`,
        )
        .all(running.job_id);
      payload.active_enrichment = {
        job_id: running.job_id,
        profile_id: running.profile_id,
        name:
          profile?.display_name ||
          [profile?.first_name, profile?.last_name].filter(Boolean).join(" "),
        current_employer: profile?.current_employer || "",
        current_title: profile?.current_title || "",
        queued_at: running.queued_at || null,
        started_at: running.started_at || null,
        specialists_pending: specialists.filter((s) => s.status === "PENDING").length,
        specialists_done: specialists.filter((s) => s.status === "DONE").length,
        specialists_failed: specialists.filter((s) => s.status === "FAILED").length,
      };
    }

    const lastDone = db
      .prepare(
        `SELECT j.job_id, j.profile_id, j.started_at, j.completed_at,
                p.display_name, p.first_name, p.last_name, p.enrichment_score, p.enrichment_score_reason
         FROM enrichment_jobs j
         JOIN profiles p ON p.profile_id = j.profile_id
         WHERE j.status='done'
         ORDER BY j.completed_at DESC
         LIMIT 1`,
      )
      .get();
    if (lastDone) {
      payload.last_completed = {
        job_id: lastDone.job_id,
        profile_id: lastDone.profile_id,
        name:
          lastDone.display_name ||
          [lastDone.first_name, lastDone.last_name].filter(Boolean).join(" "),
        enrichment_score: Number(lastDone.enrichment_score || 0),
        enrichment_score_reason: lastDone.enrichment_score_reason || "",
        started_at: lastDone.started_at || null,
        completed_at: lastDone.completed_at || null,
      };
    }

    payload.totals.profiles_total = Number(
      db.prepare(`SELECT COUNT(*) AS c FROM profiles`).get()?.c || 0,
    );
    payload.totals.profiles_enriched = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM profiles WHERE enriched_at IS NOT NULL`)
        .get()?.c || 0,
    );
    payload.totals.profiles_never_enriched = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM profiles WHERE enriched_at IS NULL`)
        .get()?.c || 0,
    );

    payload.recent_enriched = db
      .prepare(
        `SELECT profile_id, display_name, first_name, last_name, enrichment_score, enriched_at
         FROM profiles
         WHERE enriched_at IS NOT NULL
         ORDER BY enriched_at DESC
         LIMIT ?`,
      )
      .all(opts.limit)
      .map((r) => ({
        profile_id: r.profile_id,
        name: r.display_name || [r.first_name, r.last_name].filter(Boolean).join(" "),
        enrichment_score: Number(r.enrichment_score || 0),
        enriched_at: r.enriched_at || null,
      }));

    payload.recent_errors = db
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

    if (opts.profileId) {
      payload.profile_detail = {
        profile: db
          .prepare(
            `SELECT *
             FROM profiles
             WHERE profile_id = ?`,
          )
          .get(opts.profileId),
        findings: db
          .prepare(
            `SELECT finding_type, finding_value, confidence, source_url, created_at
             FROM findings
             WHERE profile_id = ?
             ORDER BY created_at DESC`,
          )
          .all(opts.profileId),
        jobs: db
          .prepare(
            `SELECT job_id, status, queued_at, started_at, completed_at, error
             FROM enrichment_jobs
             WHERE profile_id = ?
             ORDER BY queued_at DESC
             LIMIT 20`,
          )
          .all(opts.profileId),
      };
    }
  } finally {
    db.close();
  }

  return payload;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("## Enrichment Status Dashboard");
  lines.push(`_${payload.now}_`);
  lines.push("");
  lines.push(`DB: \`${payload.db_path}\``);
  lines.push("");
  lines.push("### Queue");
  lines.push(`- queued: ${payload.queue.queued}`);
  lines.push(`- running: ${payload.queue.running}`);
  lines.push(`- done: ${payload.queue.done}`);
  lines.push(`- failed: ${payload.queue.failed}`);
  lines.push("");
  if (payload.active_enrichment) {
    lines.push("### Active Enrichment");
    lines.push(`- profile: ${payload.active_enrichment.profile_id}`);
    lines.push(`- name: ${payload.active_enrichment.name || "unknown"}`);
    lines.push(
      `- specialists: ${payload.active_enrichment.specialists_done} done / ${payload.active_enrichment.specialists_pending} pending / ${payload.active_enrichment.specialists_failed} failed`,
    );
    lines.push("");
  }
  lines.push("### Profiles");
  lines.push(`- total: ${payload.totals.profiles_total || 0}`);
  lines.push(`- enriched: ${payload.totals.profiles_enriched || 0}`);
  lines.push(`- never enriched: ${payload.totals.profiles_never_enriched || 0}`);
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(
      "Usage: node scripts/status-dashboard.js [--format json|markdown] [--limit N] [--profile-id ID]",
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
