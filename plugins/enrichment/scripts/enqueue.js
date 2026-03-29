#!/usr/bin/env node

import { dbGet, newJobId, openDb } from "./db.js";
import { initSchema } from "./db-init.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let profileId = null;
  let priority = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile-id" && args[i + 1]) {
      profileId = String(args[++i]).trim();
    } else if (args[i] === "--priority" && args[i + 1]) {
      priority = Number.parseInt(args[++i], 10);
    }
  }
  return { profileId, priority: Number.isFinite(priority) ? priority : 0 };
}

function main() {
  const { profileId, priority } = parseArgs(process.argv);
  if (!profileId) {
    console.error("ERROR: --profile-id is required (UUID)");
    process.exit(1);
  }
  if (!isUuid(profileId)) {
    console.error(
      `ERROR: --profile-id must be a UUID. Received "${profileId}".`,
    );
    process.exit(1);
  }

  const db = openDb();
  try {
    initSchema(db);

    const profile = dbGet(
      db,
      `SELECT profile_id, first_name, last_name, display_name, current_employer, current_title,
              location_city, location_state
       FROM profiles
       WHERE profile_id = ?`,
      [profileId],
    );
    if (!profile) {
      console.error(`ERROR: profile_id=${profileId} not found`);
      process.exit(1);
    }

    const active = dbGet(
      db,
      `SELECT status
       FROM enrichment_jobs
       WHERE profile_id = ? AND status IN ('queued', 'running')
       ORDER BY queued_at DESC
       LIMIT 1`,
      [profileId],
    );
    if (active) {
      console.log(`SKIP:${profileId}:already_active (status=${active.status})`);
      return;
    }

    const payload = {
      profile_id: profile.profile_id,
      first_name: profile.first_name || "",
      last_name: profile.last_name || "",
      display_name: profile.display_name || "",
      current_employer: profile.current_employer || "",
      current_title: profile.current_title || "",
      location_city: profile.location_city || "",
      location_state: profile.location_state || "",
    };

    const agentId = process.env.ENRICH_ORCH_AGENT_ID || "profile-enrich";
    const workspace =
      process.env.ENRICHMENT_WORKSPACE || path.join(__dirname, "..");
    db.prepare(
      `INSERT INTO enrichment_jobs (
         job_id, profile_id, payload_json, orchestrator_agent_id, orchestrator_workspace,
         message_prefix, status, priority, queued_at
       ) VALUES (?, ?, ?, ?, ?, 'ENRICH', 'queued', ?, datetime('now'))`,
    ).run(
      newJobId(),
      profileId,
      JSON.stringify(payload),
      agentId,
      workspace,
      priority,
    );

    console.log(`QUEUED:${profileId}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err.message}`);
  process.exit(1);
}
