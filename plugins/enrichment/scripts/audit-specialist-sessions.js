#!/usr/bin/env node
/**
 * Audit specialist subagent sessions for a completed enrichment job.
 * Usage:
 *   node scripts/audit-specialist-sessions.js
 *   node scripts/audit-specialist-sessions.js --job-id job_xxx
 *   node scripts/audit-specialist-sessions.js --agent-id profile-enrich
 *
 * Requires ENRICHMENT_DB_PATH or default ~/.openclaw/enrichment/enrichment.db
 * and OpenClaw state dir for sessions (OPENCLAW_STATE_DIR or ~/.openclaw).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db.js";

function parseArgs(argv) {
  const out = { "job-id": null, "agent-id": null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--job-id" && argv[i + 1]) out["job-id"] = argv[++i];
    else if (a === "--agent-id" && argv[i + 1]) out["agent-id"] = argv[++i];
  }
  return out;
}

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function parseChildSessionKey(rawKey) {
  const key = String(rawKey || "").trim();
  const m = key.match(/^agent:([^:]+):subagent:([^:]+)$/);
  if (!m) return null;
  return { key, childAgentId: m[1], subagentId: m[2] };
}

function loadSessionsContextForAgent(agentId, cache) {
  const aid = String(agentId || "").trim();
  if (!aid) return { ok: false, reason: "missing_agent_id" };
  if (cache.has(aid)) return cache.get(aid);
  const sessionsDir = path.join(stateDir(), "agents", aid, "sessions");
  const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
  let out;
  if (!fs.existsSync(sessionsJsonPath)) {
    out = { ok: false, reason: "missing_sessions_json", sessionsJsonPath, sessionsDir };
  } else {
    try {
      const sessionsMap = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf8"));
      out = { ok: true, sessionsMap, sessionsDir, sessionsJsonPath };
    } catch {
      out = { ok: false, reason: "invalid_sessions_json", sessionsJsonPath, sessionsDir };
    }
  }
  cache.set(aid, out);
  return out;
}

function extractJsonFromMarkdown(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

function auditSessionFile(filePath) {
  const counts = { web_search: 0, web_fetch: 0, browser: 0, other_tool: 0 };
  const queries = [];
  let lastParsed = null;
  let lastFindingsLen = null;
  let lastAgent = null;
  let linesParsed = 0;

  if (!fs.existsSync(filePath)) {
    return {
      counts,
      queries,
      lastParsed,
      lastFindingsLen,
      lastAgent,
      linesParsed,
      error: "missing_file",
    };
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  for (const ln of lines) {
    let ev;
    try {
      ev = JSON.parse(ln);
    } catch {
      continue;
    }
    linesParsed++;

    if (ev.type === "message" && ev.message?.role === "assistant" && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c?.type === "toolCall" && c.name) {
          if (c.name === "web_search") counts.web_search++;
          else if (c.name === "web_fetch") counts.web_fetch++;
          else if (c.name === "browser" || String(c.name).includes("browser")) counts.browser++;
          else counts.other_tool++;
        }
        if (c?.type === "text" && typeof c.text === "string") {
          const parsed = extractJsonFromMarkdown(c.text);
          if (parsed && typeof parsed === "object") {
            lastParsed = parsed;
            lastAgent = parsed.agent ?? null;
            lastFindingsLen = Array.isArray(parsed.findings) ? parsed.findings.length : null;
          }
        }
      }
    }

    if (ev.type === "message" && ev.message?.role === "toolResult" && ev.message?.toolName === "web_search") {
      const content = ev.message.content;
      const first = Array.isArray(content) ? content[0] : null;
      if (first?.type === "text" && typeof first.text === "string") {
        try {
          const j = JSON.parse(first.text);
          if (j.query) queries.push(String(j.query));
        } catch {
          /* ignore */
        }
      }
    }
  }

  return {
    counts,
    queries,
    lastParsed,
    lastFindingsLen,
    lastAgent,
    linesParsed,
    error: null,
  };
}

function main() {
  const flags = parseArgs(process.argv);
  const db = openDb();
  let job;
  if (flags["job-id"]) {
    job = db
      .prepare(
        `SELECT job_id, profile_id, orchestrator_agent_id, completed_at, status
         FROM enrichment_jobs WHERE job_id = ?`,
      )
      .get(flags["job-id"]);
  } else {
    job = db
      .prepare(
        `SELECT job_id, profile_id, orchestrator_agent_id, completed_at, status
         FROM enrichment_jobs WHERE status = 'done' ORDER BY completed_at DESC LIMIT 1`,
      )
      .get();
  }
  if (!job) {
    console.error("ERROR: no matching job found");
    db.close();
    process.exit(1);
  }

  const runs = db
    .prepare(
      `SELECT specialist_name, status, child_session_key, completed_at
       FROM enrichment_specialist_runs WHERE job_id = ? ORDER BY specialist_name`,
    )
    .all(job.job_id);

  db.close();

  const sessionsCache = new Map();
  const rows = [];
  for (const r of runs) {
    const key = String(r.child_session_key || "").trim();
    const parsedKey = parseChildSessionKey(key);
    let sid = null;
    let jsonl = null;
    let childAgentId = null;
    let audit = { error: "no_session_key", counts: {}, queries: [] };
    let sessionsError = null;

    if (!parsedKey) {
      sessionsError = "invalid_child_session_key";
      audit = { error: "invalid_child_session_key", counts: {}, queries: [] };
    } else {
      childAgentId = parsedKey.childAgentId;
      const sessionsCtx = loadSessionsContextForAgent(childAgentId, sessionsCache);
      if (!sessionsCtx.ok) {
        sessionsError = sessionsCtx.reason || "sessions_unavailable";
        audit = { error: sessionsError, counts: {}, queries: [] };
      } else {
        const meta = sessionsCtx.sessionsMap?.[parsedKey.key] || null;
        sid = meta?.sessionId || null;
        jsonl = sid ? path.join(sessionsCtx.sessionsDir, `${sid}.jsonl`) : null;
        audit = jsonl
          ? auditSessionFile(jsonl)
          : { error: "session_not_found_in_map", counts: {}, queries: [] };
      }
    }

    let failureMode = "—";
    if (audit.error === "missing_file") failureMode = "session file missing";
    else if (audit.error === "no_session_key") failureMode = "no child_session_key";
    else if (audit.error === "invalid_child_session_key") failureMode = "invalid child_session_key format";
    else if (audit.error === "missing_sessions_json") failureMode = "missing child agent sessions.json";
    else if (audit.error === "invalid_sessions_json") failureMode = "invalid child agent sessions.json";
    else if (audit.error === "session_not_found_in_map") failureMode = "session key absent from child agent sessions.json";
    else if (audit.lastFindingsLen === 0) failureMode = "no verified findings";
    else if (audit.lastFindingsLen == null) failureMode = "no final JSON block parsed";

    rows.push({
      specialist: r.specialist_name,
      run_status: r.status,
      child_agent_id: childAgentId,
      child_session_key: key || null,
      session_id: sid || null,
      jsonl: jsonl,
      sessions_error: sessionsError,
      web_search: audit.counts.web_search ?? 0,
      web_fetch: audit.counts.web_fetch ?? 0,
      browser: audit.counts.browser ?? 0,
      other_tool: audit.counts.other_tool ?? 0,
      search_queries: audit.queries?.length ?? 0,
      findings_count: audit.lastFindingsLen,
      output_agent: audit.lastAgent,
      sample_queries: (audit.queries || []).slice(0, 3),
      failure_mode: failureMode,
    });
  }

  const summary = {
    job_id: job.job_id,
    profile_id: job.profile_id,
    orchestrator_agent_id: String(job.orchestrator_agent_id || "").trim() || null,
    forced_agent_id: flags["agent-id"] || null,
    completed_at: job.completed_at,
    specialists_audited: rows.length,
  };

  console.log(JSON.stringify({ summary, specialists: rows }, null, 2));
}

main();
