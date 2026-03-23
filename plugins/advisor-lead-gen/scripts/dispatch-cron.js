#!/usr/bin/env node
/**
 * dispatch-cron.js — Poll the enrichment queue and fire ENRICH automatically.
 *
 * Runs as a long-lived process. Every POLL_INTERVAL_MS (default 5s):
 *   1. Check DB: anything running?
 *      - Running < stale threshold → RUNNING (wait)
 *      - Running > stale threshold → STALE: mark failed + reset session + continue
 *   2. Check DB: any row with status='queued'? → reset session + fire ENRICH
 *   3. Nothing queued? → IDLE, wait for next tick
 *
 * Only one advisor runs at a time. The 'queued' row written by enqueue-enrich.js
 * acts as the lock — no second ENRICH can fire until the first row is 'done'.
 *
 * Stale detection: if a row stays 'running' longer than --stale-minutes (default 5),
 * the cron marks it 'failed' and resets the session so the next queued advisor
 * can proceed. The stale advisor can be re-queued manually.
 *
 * NOTE: In production this is not required.
 * The OpenClaw plugin runs an in-gateway dispatcher service that drains the queue.
 *
 * Run directly for testing/debugging:
 *   node scripts/dispatch-cron.js --dry-run
 *
 * Flags:
 *   --interval N        Poll interval in seconds (default: 5)
 *   --stale-minutes N   Minutes before a running row is declared stuck (default: 5)
 *   --dry-run           Log what would happen without firing or mutating DB
 *
 * Output (timestamped lines):
 *   [HH:MM:SS] IDLE     — nothing queued or running
 *   [HH:MM:SS] RUNNING  — sec_id=X (NAME), Nm elapsed, waiting...
 *   [HH:MM:SS] STALE    — sec_id=X (NAME) stuck >Nmin, marking failed
 *   [HH:MM:SS] DISPATCH — sec_id=X (NAME)
 *   [HH:MM:SS] FIRED    — agent returned, checking queue again
 *   [HH:MM:SS] ERROR    — <message>
 *
 * Uses node:sqlite (built-in Node 22.5+) — no npm install required.
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openDb, dbGet } from "./db.js";
import { initSchema } from "./db-init.js";
import { resetSession } from "./reset-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "advisors.db");
const AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";

function parseArgs(argv) {
  const args = argv.slice(2);
  let intervalSecs = 5;
  let staleMinutes = 5;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interval" && args[i + 1])
      intervalSecs = parseInt(args[++i], 10);
    if (args[i] === "--stale-minutes" && args[i + 1])
      staleMinutes = parseInt(args[++i], 10);
    if (args[i] === "--dry-run") dryRun = true;
  }
  return { intervalSecs, staleMinutes, dryRun };
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function checkQueue(db) {
  // Anything currently running?
  const running = dbGet(
    db,
    `SELECT eq.sec_id, eq.started_at, a.first_name, a.last_name
     FROM enrichment_queue eq
     LEFT JOIN advisors a USING(sec_id)
     WHERE eq.status = 'running'
     LIMIT 1`,
  );
  if (running) {
    const startedMs = running.started_at
      ? new Date(
          running.started_at.includes("T")
            ? running.started_at
            : running.started_at.replace(" ", "T") + "Z",
        ).getTime()
      : Date.now();
    const elapsedMs = Date.now() - startedMs;
    return { state: "running", row: running, elapsedMs };
  }

  // Oldest queued row ready to fire?
  const queued = dbGet(
    db,
    `SELECT eq.sec_id, eq.advisor_json, a.first_name, a.last_name
     FROM enrichment_queue eq
     LEFT JOIN advisors a USING(sec_id)
     WHERE eq.status = 'queued'
     ORDER BY eq.queued_at ASC
     LIMIT 1`,
  );
  if (queued) return { state: "queued", row: queued };

  return { state: "idle" };
}

function markFailed(db, secId) {
  db.prepare(
    `UPDATE enrichment_queue
     SET status = 'failed', completed_at = datetime('now')
     WHERE sec_id = ? AND status = 'running'`,
  ).run(secId);
}

function fireEnrich(advisorJson, dryRun) {
  const message = `ENRICH:${advisorJson}`;

  if (dryRun) {
    log(
      `DRY-RUN — would fire: openclaw agent --agent ${AGENT_ID} --message '${message}'`,
    );
    return;
  }

  // Reset session so the orchestrator starts with a blank context.
  try {
    const reset = resetSession();
    if (reset.cleared) log(`SESSION RESET — cleared ${reset.sessionId}`);
    else log(`SESSION RESET — already clean`);
  } catch (err) {
    log(`WARN — session reset failed: ${err.message} (proceeding anyway)`);
  }

  log(`FIRING — openclaw agent --agent ${AGENT_ID}`);

  const result = spawnSync(
    "openclaw",
    ["agent", "--agent", AGENT_ID, "--message", message, "--timeout", "600"],
    { encoding: "utf8", timeout: 660_000 },
  );

  if (result.error) {
    log(`ERROR — spawn failed: ${result.error.message}`);
  } else if (result.status !== 0) {
    log(
      `ERROR — exit ${result.status}: ${(result.stderr || "").trim().slice(0, 200)}`,
    );
  } else {
    log(`FIRED — agent returned (exit 0)`);
  }
}

function advisorLabel(row) {
  const name =
    [row.first_name, row.last_name].filter(Boolean).join(" ") || "(unknown)";
  return `sec_id=${row.sec_id} (${name})`;
}

async function main() {
  const { intervalSecs, staleMinutes, dryRun } = parseArgs(process.argv);
  const pollMs = intervalSecs * 1000;
  const staleMs = staleMinutes * 60 * 1000;

  log(
    `dispatch-cron starting — poll every ${intervalSecs}s, stale after ${staleMinutes}min, agent=${AGENT_ID}${dryRun ? ", DRY-RUN" : ""}`,
  );
  log(`Stop: Ctrl+C`);

  // PM2 sends SIGTERM to stop; Ctrl+C sends SIGINT. Handle both cleanly.
  const shutdown = (signal) => { log(`${signal} — shutting down`); process.exit(0); };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (true) {
    let db;
    try {
      db = openDb(DB_PATH);
      initSchema(db);
      const { state, row, elapsedMs } = checkQueue(db);

      if (state === "running") {
        const elapsedMin = Math.floor(elapsedMs / 60000);

        if (elapsedMs > staleMs) {
          log(
            `STALE — ${advisorLabel(row)} stuck >${staleMinutes}min (${elapsedMin}min elapsed), marking failed`,
          );
          if (!dryRun) {
            markFailed(db, row.sec_id);
            db.close();
            db = null;
            // Reset session so the next advisor starts clean.
            try {
              const reset = resetSession();
              log(
                `SESSION RESET — ${reset.cleared ? `cleared ${reset.sessionId}` : "already clean"}`,
              );
            } catch (err) {
              log(`WARN — session reset failed: ${err.message}`);
            }
          } else {
            log(
              `DRY-RUN — would mark sec_id=${row.sec_id} failed and reset session`,
            );
          }
        } else {
          log(
            `RUNNING — ${advisorLabel(row)}, ${elapsedMin}min elapsed, waiting...`,
          );
        }
      } else if (state === "queued") {
        log(`DISPATCH — ${advisorLabel(row)}`);
        db.close();
        db = null;
        fireEnrich(row.advisor_json, dryRun);
      } else {
        log(`IDLE — nothing queued or running`);
      }
    } catch (err) {
      log(`ERROR — ${err.message}`);
    } finally {
      if (db) db.close();
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main();
