#!/usr/bin/env node
/**
 * reset-session.js — Reset the advisor-enrich main session.
 *
 * Deletes the advisor-enrich:main conversation history so the next ENRICH
 * always starts with a blank context window. Without this, prior enrichment
 * turns accumulate in session history and the orchestrator LLM can
 * misinterpret new ENRICH commands as duplicates of work it already did.
 *
 * Safe to call any time no enrichment is actively in progress.
 * Idempotent: if no session exists, exits cleanly with RESET:none.
 *
 * Called automatically by dispatch-cron.js immediately before firing
 * ENRICH: payloads, ensuring the session is always clean when ENRICH arrives.
 * Can also be called directly for manual recovery:
 *
 *   node scripts/reset-session.js
 *   npm run reset:session
 *
 * Env overrides:
 *   OPENCLAW_HOME         default: ~/.openclaw
 *   ADVISOR_ORCH_AGENT_ID default: advisor-enrich
 *
 * Output:
 *   RESET:cleared:<session_id>  — session was found and deleted
 *   RESET:none                  — no session existed (already clean)
 *   ERROR:<message>             — unexpected failure (exits 1)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
const SESSION_KEY = `agent:${AGENT_ID}:main`;
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const SESSIONS_DIR = path.join(OPENCLAW_HOME, "agents", AGENT_ID, "sessions");
const SESSIONS_JSON = path.join(SESSIONS_DIR, "sessions.json");

/**
 * Reset the agent's main session.
 * Returns { cleared: true, sessionId } or { cleared: false }.
 * Throws on unexpected filesystem errors.
 */
function resetSession() {
  if (!fs.existsSync(SESSIONS_JSON)) {
    return { cleared: false };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
  } catch (err) {
    throw new Error(`cannot parse sessions.json — ${err.message}`);
  }

  const entry = data[SESSION_KEY];
  if (!entry || !entry.sessionId) {
    return { cleared: false };
  }

  const sessionId = entry.sessionId;
  const jsonlPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);

  // Delete the conversation history file.
  if (fs.existsSync(jsonlPath)) {
    try {
      fs.unlinkSync(jsonlPath);
    } catch (err) {
      throw new Error(`cannot delete session file ${jsonlPath} — ${err.message}`);
    }
  }

  // Remove the entry from the session index.
  delete data[SESSION_KEY];
  try {
    fs.writeFileSync(SESSIONS_JSON, JSON.stringify(data), 'utf8');
  } catch (err) {
    throw new Error(`cannot update sessions.json — ${err.message}`);
  }

  return { cleared: true, sessionId };
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

// CLI entry point — only runs when called directly.
if (isMain) {
  try {
    const result = resetSession();
    if (result.cleared) {
      console.log(`RESET:cleared:${result.sessionId}`);
    } else {
      console.log('RESET:none');
    }
  } catch (err) {
    console.error(`ERROR:${err.message}`);
    process.exit(1);
  }
}

export { resetSession };
