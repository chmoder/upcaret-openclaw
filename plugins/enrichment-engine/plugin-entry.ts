// @ts-nocheck
import fs, { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let definePluginEntry: undefined | ((entry: any) => any);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  definePluginEntry = require("openclaw/plugin-sdk/plugin-entry")?.definePluginEntry;
} catch {}

const entry = {
  id: "enrichment-engine",
  name: "OpenClaw Enrichment Engine",
  description: "Generic queue dispatcher for enrichment pipelines",
  register(api: any) {
    const stateDir = api.runtime.state.resolveStateDir();
    const ROOT = join(stateDir, "extensions", "enrichment-engine");
    const log = api.logger;

    const POLL_INTERVAL_MS = Number.parseInt(process.env.ENRICH_ENGINE_INTERVAL_MS || "", 10);
    const STALE_MINUTES = Number.parseInt(process.env.ENRICH_ENGINE_STALE_MINUTES || "", 10);

    const pollMs =
      Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0 ? POLL_INTERVAL_MS : 5_000;
    // Wall-clock cap for a single job in `running` (aligned with DB default
    // `enrichment_pipelines.stale_minutes` and README). Advisor enrichment uses
    // ~90s specialist budgets; five minutes total is plenty — beyond that mark failed.
    const staleMs =
      Number.isFinite(STALE_MINUTES) && STALE_MINUTES > 0 ? STALE_MINUTES * 60_000 : 5 * 60_000;
    const engineDbPath =
      process.env.ENRICHMENT_ENGINE_DB_PATH ||
      join(api.runtime.state.resolveStateDir(), "enrichment", "enrichment.db");

    function normalizeAgentId(id: string) {
      return (id || "").trim().toLowerCase();
    }

    function parseEntityLabel(entityId: string) {
      const value = String(entityId || "");
      const split = value.split(":");
      if (split.length >= 2) {
        return `${split[0]}:${split.slice(1).join(":")}`;
      }
      return value || "(unknown)";
    }

    async function openEngineDb() {
      const dir = join(engineDbPath, "..");
      fs.mkdirSync(dir, { recursive: true });
      const { openDb } = await import(pathToFileURL(join(ROOT, "scripts/db.js")).href);
      const { initSchema } = await import(pathToFileURL(join(ROOT, "scripts/db-init.js")).href);
      const db = openDb(engineDbPath);
      initSchema(db);
      return db;
    }

    async function getQueueState(db: any) {
      const { dbGet } = await import(pathToFileURL(join(ROOT, "scripts/db.js")).href);
      const running = dbGet(
        db,
        `SELECT j.job_id, j.pipeline_id, j.entity_type, j.entity_id, j.started_at,
                COALESCE(NULLIF(j.orchestrator_agent_id, ''), p.orchestrator_agent_id, '') AS orchestrator_agent_id,
                COALESCE(NULLIF(j.message_prefix, ''), p.message_prefix, '') AS message_prefix,
                j.payload_json,
                COALESCE(NULLIF(j.orchestrator_workspace, ''), p.orchestrator_workspace, '') AS orchestrator_workspace
         FROM enrichment_jobs j
         LEFT JOIN enrichment_pipelines p ON p.pipeline_id = j.pipeline_id
         WHERE j.status='running'
         ORDER BY j.started_at ASC
         LIMIT 1`,
      );
      if (running) {
        const startedMs = running.started_at
          ? new Date(
              String(running.started_at).includes("T")
                ? String(running.started_at)
                : String(running.started_at).replace(" ", "T") + "Z",
            ).getTime()
          : Date.now();
        return {
          state: "running" as const,
          row: running,
          elapsedMs: Date.now() - startedMs,
        };
      }

      const queued = dbGet(
        db,
        `SELECT j.job_id, j.pipeline_id, j.entity_type, j.entity_id, j.payload_json,
                COALESCE(NULLIF(j.orchestrator_agent_id, ''), p.orchestrator_agent_id) AS orchestrator_agent_id,
                COALESCE(NULLIF(j.orchestrator_workspace, ''), p.orchestrator_workspace, '') AS orchestrator_workspace,
                COALESCE(NULLIF(j.message_prefix, ''), p.message_prefix, 'ENRICH') AS message_prefix
         FROM enrichment_jobs j
         LEFT JOIN enrichment_pipelines p ON p.pipeline_id = j.pipeline_id
         WHERE j.status='queued'
           AND j.payload_json IS NOT NULL
           AND LENGTH(TRIM(j.payload_json)) > 0
           AND (p.enabled IS NULL OR p.enabled = 1)
         ORDER BY j.priority DESC, j.queued_at ASC
         LIMIT 1`,
      );
      if (queued) {
        return { state: "queued" as const, row: queued };
      }
      return { state: "idle" as const };
    }

    async function markFailed(db: any, jobId: string, error?: string) {
      db.prepare(
        `UPDATE enrichment_jobs
         SET status='failed',
             completed_at=datetime('now'),
             error=COALESCE(?, error)
         WHERE job_id = ? AND status='running'`,
      ).run(error ?? null, jobId);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_failed', ?, NULL, datetime('now'))`,
      ).run(jobId, String(error || "job failed"));
    }

    async function failQueuedOrRunning(db: any, jobId: string, error?: string) {
      db.prepare(
        `UPDATE enrichment_jobs
         SET status='failed',
             completed_at=datetime('now'),
             error=COALESCE(?, error)
         WHERE job_id = ? AND status IN ('queued','running')`,
      ).run(error ?? null, jobId);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_failed', ?, NULL, datetime('now'))`,
      ).run(jobId, String(error || "job failed"));
    }

    async function requeueRunning(db: any, jobId: string, reason: string) {
      db.prepare(
        `UPDATE enrichment_jobs
         SET status='queued',
             started_at=NULL,
             completed_at=NULL,
             error=COALESCE(?, error)
         WHERE job_id = ? AND status='running'`,
      ).run(reason ?? null, jobId);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_requeued', ?, NULL, datetime('now'))`,
      ).run(jobId, String(reason || "job requeued"));
    }

    async function markRunning(db: any, jobId: string) {
      const alreadyRunning = db
        .prepare(`SELECT job_id FROM enrichment_jobs WHERE status='running' AND job_id != ? LIMIT 1`)
        .get(jobId);
      if (alreadyRunning?.job_id) {
        return { ok: false as const, reason: "another_running" as const, jobId: alreadyRunning.job_id };
      }
      const res = db
        .prepare(
          `UPDATE enrichment_jobs
           SET status='running',
               started_at=datetime('now'),
               attempt_count=attempt_count+1
           WHERE job_id=? AND status='queued'`,
        )
        .run(jobId);
      return { ok: res.changes > 0 };
    }

    async function ensureAgentConfig(cfg: any, agentId: string, workspacePath: string) {
      const wanted = normalizeAgentId(agentId);
      if (!wanted) {
        return cfg;
      }
      const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
      const exists = list.some((a: any) => normalizeAgentId(String(a?.id || "")) === wanted);
      if (exists) {
        return cfg;
      }
      const patched = {
        ...cfg,
        agents: {
          ...(cfg?.agents ?? {}),
          list: [
            ...(Array.isArray(cfg?.agents?.list) ? cfg.agents.list : []),
            {
              id: agentId,
              name: `Enrichment: ${agentId}`,
              workspace: workspacePath,
              model: cfg?.agents?.defaults?.model,
            },
          ],
        },
      };
      try {
        await api.runtime.config.writeConfigFile(patched);
        log.info(`Configured agent "${agentId}" workspace=${workspacePath}`);
      } catch (err: any) {
        log.warn(`WARN — unable to persist agent config: ${String(err?.message ?? err)}`);
      }
      return patched;
    }

    function shouldResetSessionForPipeline(pipelineId: string) {
      const mode = String(process.env.ENRICH_ENGINE_SESSION_RESET_MODE || "").trim().toLowerCase();
      if (mode === "always") return true;
      if (mode === "never") return false;
      // Default: reset before every newly dispatched entity/job.
      return true;
    }

    async function resetSessionBestEffort(agentId: string) {
      try {
        const sessionsDir = join(stateDir, "agents", agentId, "sessions");
        const sessionsJson = join(sessionsDir, "sessions.json");
        if (!existsSync(sessionsJson)) {
          return { ok: true as const, reason: "no_sessions_json" as const };
        }

        // If any lock file exists in this sessions dir, skip reset to avoid races.
        try {
          const files = fs.readdirSync(sessionsDir);
          if (files.some((f) => f.endsWith(".lock"))) {
            log.warn(`SESSION RESET SKIP — lock file present for agent=${agentId}`);
            return { ok: false as const, reason: "lock_present" as const };
          }
        } catch {}

        const sessionKey = `agent:${agentId}:main`;
        const raw = fs.readFileSync(sessionsJson, "utf8");
        const data = JSON.parse(raw || "{}");
        const current = data?.[sessionKey];
        const sessionId = current?.sessionId;
        if (!sessionId) {
          return { ok: true as const, reason: "no_session_mapping" as const };
        }

        const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
        if (existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
          } catch {}
        }
        delete data[sessionKey];
        fs.writeFileSync(sessionsJson, JSON.stringify(data), "utf8");
        log.info(`SESSION RESET — agent=${agentId} session=${sessionId}`);
        return { ok: true as const, reason: "reset" as const };
      } catch (err: any) {
        log.warn(`WARN — session reset failed: ${String(err?.message ?? err)}`);
        return { ok: false as const, reason: "error" as const };
      }
    }

    function agentRunEnv(params: {
      jobId: string;
      pipelineId: string;
      entityType: string;
      entityId: string;
    }) {
      const configPath = process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      return {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        ENRICHMENT_ENGINE_DB_PATH: engineDbPath,
        ENRICHMENT_ENGINE_WORKSPACE: ROOT,
        ENRICHMENT_JOB_ID: params.jobId,
        ENRICHMENT_PIPELINE_ID: params.pipelineId,
        ENRICHMENT_ENTITY_TYPE: params.entityType,
        ENRICHMENT_ENTITY_ID: params.entityId,
      };
    }

    function formatAgentFailure(jobId: string, r: any) {
      const stdout = String(r?.stdout ?? "").trim();
      const stderr = String(r?.stderr ?? "").trim();
      const detail = [
        r?.termination ? `termination=${r.termination}` : null,
        r?.code != null ? `exit=${r.code}` : null,
        r?.signal ? `signal=${r.signal}` : null,
        stderr ? `stderr=${stderr.slice(0, 4_000)}` : null,
        stdout ? `stdout=${stdout.slice(0, 4_000)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      return `openclaw agent failed (job=${jobId}): ${detail}`;
    }

    /** When child subagent sessions are already `done` in sessions.json but DB still PENDING (auto-resume missed). */
    function reconcilePendingSpecialistsFromSessions(
      db: any,
      jobId: string,
      agentId: string,
    ): number {
      const aid = String(agentId || "").trim();
      if (!aid) return 0;
      const sessionsJsonPath = join(stateDir, "agents", aid, "sessions", "sessions.json");
      if (!existsSync(sessionsJsonPath)) return 0;
      let map: Record<string, any>;
      try {
        map = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf8"));
      } catch {
        return 0;
      }
      const pending = db
        .prepare(
          `SELECT specialist_name, child_session_key
           FROM enrichment_specialist_runs
           WHERE job_id = ?
             AND status = 'PENDING'
             AND child_session_key IS NOT NULL
             AND LENGTH(TRIM(child_session_key)) > 0`,
        )
        .all(jobId);
      let n = 0;
      for (const row of pending) {
        const key = String(row.child_session_key || "").trim();
        if (!key) continue;
        const entry = map[key];
        const st = entry && String(entry.status || "").toLowerCase();
        if (st === "done") {
          db.prepare(
            `UPDATE enrichment_specialist_runs
             SET status='DONE', completed_at=datetime('now')
             WHERE job_id=? AND specialist_name=? AND status='PENDING'`,
          ).run(jobId, row.specialist_name);
          n++;
        }
      }
      return n;
    }

    function startAgentRun(params: {
      agentId: string;
      messagePrefix: string;
      payloadJson: string;
      jobId: string;
      pipelineId: string;
      entityType: string;
      entityId: string;
    }) {
      const configPath = process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      const prefix = String(params.messagePrefix || "ENRICH").trim() || "ENRICH";
      const message = `${prefix}:${params.payloadJson}`;
      const agentTimeoutSeconds = Math.max(300, Math.ceil((staleMs + 60_000) / 1000));
      const argv = [
        "openclaw",
        "agent",
        "--agent",
        params.agentId,
        "--message",
        message,
        "--timeout",
        String(agentTimeoutSeconds),
      ];
      const runPromise = api.runtime.system.runCommandWithTimeout(argv, {
        timeoutMs: Math.max(330_000, staleMs + 90_000),
        env: agentRunEnv(params),
      });

      return {
        wait: () =>
          runPromise
            .then((r: any) => {
              if (r?.code === 0) {
                return { ok: true as const };
              }
              return {
                ok: false as const,
                error: formatAgentFailure(params.jobId, r),
              };
            })
            .catch((err: any) => ({
              ok: false as const,
              error: `openclaw agent failed (job=${params.jobId}): ${String(err?.message ?? err)}`,
            })),
      };
    }

    /**
     * Advisor pipeline: one ENRICH turn rarely reaches DONE (orchestrator yields after spawn).
     * OpenClaw expects follow-up TICK messages until stdout contains DONE: or save-enrichment marks the job done.
     */
    function startAdvisorEnrichLoop(params: {
      agentId: string;
      messagePrefix: string;
      payloadJson: string;
      jobId: string;
      pipelineId: string;
      entityType: string;
      entityId: string;
    }) {
      const configPath = process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      const turnSecRaw = Number.parseInt(process.env.ENRICH_ADVISOR_TURN_TIMEOUT_SEC || "", 10);
      const turnSec =
        Number.isFinite(turnSecRaw) && turnSecRaw >= 60 ? turnSecRaw : 300;
      const maxTicksRaw = Number.parseInt(process.env.ENRICH_ADVISOR_MAX_TICKS || "", 10);
      const maxTicks = Number.isFinite(maxTicksRaw) && maxTicksRaw > 0 ? maxTicksRaw : 40;
      const pauseMsRaw = Number.parseInt(process.env.ENRICH_ADVISOR_TICK_PAUSE_MS || "", 10);
      const pauseMs =
        Number.isFinite(pauseMsRaw) && pauseMsRaw >= 0 ? pauseMsRaw : 4_000;

      const enrichPrefix = String(params.messagePrefix || "ENRICH").trim() || "ENRICH";
      const payload = String(params.payloadJson || "");
      const env = agentRunEnv(params);

      const runPromise = (async () => {
        type Phase = "enrich" | "complete" | "complete_tick";
        let phase: Phase = "enrich";
        let enrichStdout = "";
        let completeStdout = "";
        for (let i = 0; i < maxTicks; i++) {
          const isFirst = i === 0;
          const message =
            phase === "enrich"
              ? isFirst
                ? `${enrichPrefix}:${payload}`
                : `TICK:${payload}`
              : phase === "complete"
                ? `COMPLETE:${payload}`
                : `COMPLETE_TICK:${payload}`;

          let db0: any | null = null;
          try {
            db0 = await openEngineDb();
            const row = db0
              .prepare(`SELECT status FROM enrichment_jobs WHERE job_id = ?`)
              .get(params.jobId);
            if (!row || row.status !== "running") {
              if (row?.status === "done") {
                return { ok: true as const };
              }
              return {
                ok: false as const,
                error: `advisor enrich stopped: job ${params.jobId} not running (status=${row?.status ?? "missing"})`,
              };
            }
            const n = reconcilePendingSpecialistsFromSessions(
              db0,
              params.jobId,
              params.agentId,
            );
            if (n > 0) {
              log.info(
                `RECONCILE — job=${params.jobId} marked ${n} specialist(s) DONE from session store`,
              );
            }
          } finally {
            if (db0) {
              try {
                db0.close();
              } catch {}
            }
          }

          log.info(
            `ADVISORS — job=${params.jobId} step=${i + 1}/${maxTicks} ${
              phase === "enrich"
                ? isFirst
                  ? enrichPrefix
                  : "TICK"
                : phase === "complete"
                  ? "COMPLETE"
                  : "COMPLETE_TICK"
            }`,
          );

          const argv = [
            "openclaw",
            "agent",
            "--agent",
            params.agentId,
            "--message",
            message,
            "--timeout",
            String(turnSec),
          ];
          const r: any = await api.runtime.system.runCommandWithTimeout(argv, {
            timeoutMs: turnSec * 1000 + 45_000,
            env: { ...env, OPENCLAW_CONFIG_PATH: configPath },
          });
          if (phase === "enrich") {
            enrichStdout += String(r?.stdout ?? "");
          } else {
            completeStdout += String(r?.stdout ?? "");
          }

          if (enrichStdout.includes("DONE:") || completeStdout.includes("DONE:")) {
            return { ok: true as const };
          }

          if (phase === "enrich" && enrichStdout.includes("ALL_SPECIALISTS_DONE:")) {
            log.info(`ADVISORS — job=${params.jobId} ALL_SPECIALISTS_DONE: switching to COMPLETE`);
            await resetSessionBestEffort(params.agentId);
            // Give the filesystem a moment to settle before next phase.
            await new Promise((res) => setTimeout(res, 2_000));
            phase = "complete";
            completeStdout = "";
          } else if (phase === "complete" && completeStdout.includes("SCORE_SPAWNED:")) {
            log.info(`ADVISORS — job=${params.jobId} SCORE_SPAWNED: switching to COMPLETE_TICK`);
            phase = "complete_tick";
          }

          let db1: any | null = null;
          try {
            db1 = await openEngineDb();
            const st = db1
              .prepare(`SELECT status FROM enrichment_jobs WHERE job_id = ?`)
              .get(params.jobId);
            if (st?.status === "done") {
              return { ok: true as const };
            }
          } finally {
            if (db1) {
              try {
                db1.close();
              } catch {}
            }
          }

          if (r?.code !== 0 && i === maxTicks - 1) {
            return { ok: false as const, error: formatAgentFailure(params.jobId, r) };
          }
          if (r?.code !== 0) {
            log.warn(
              `ADVISORS — job=${params.jobId} non-zero exit on step ${i + 1} (continuing TICK loop): ${formatAgentFailure(params.jobId, r).slice(0, 500)}`,
            );
          }

          if (i < maxTicks - 1 && pauseMs > 0) {
            await new Promise((res) => setTimeout(res, pauseMs));
          }
        }
        return {
          ok: false as const,
          error: `advisor enrich exceeded ${maxTicks} turns without DONE: (job=${params.jobId})`,
        };
      })();

      return {
        wait: () =>
          runPromise
            .then((out: any) => out)
            .catch((err: any) => ({
              ok: false as const,
              error: `advisor enrich loop failed (job=${params.jobId}): ${String(err?.message ?? err)}`,
            })),
      };
    }

    function validateSetup(): string[] {
      const errors: string[] = [];
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 5)) {
        errors.push(
          `Node ${process.versions.node} is too old — requires 22.5+. Upgrade: https://nodejs.org`,
        );
      }
      for (const rel of ["scripts/db.js", "scripts/db-init.js"]) {
        if (!existsSync(join(ROOT, rel))) {
          errors.push(`Missing ${rel} — reinstall enrichment-engine.`);
        }
      }
      return errors;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let tickInFlight: Promise<void> | null = null;
    let activeRun: null | { jobId: string; wait: () => Promise<any> } = null;
    let lastIdleLogAt = 0;
    let dispatchCooldownUntilMs = 0;

    api.registerService({
      id: "enrichment-engine-dispatcher",
      start: async () => {
        if (interval) {
          log.warn("enrichment-engine dispatcher already running (start ignored)");
          return;
        }

        const errors = validateSetup();
        if (errors.length > 0) {
          log.error("SETUP ERRORS — fix these and restart the gateway:");
          errors.forEach((e, i) => log.error(`  ${i + 1}. ${e}`));
          return;
        }

        try {
          await fs.promises.mkdir(join(engineDbPath, ".."), { recursive: true });
          const db = await openEngineDb();
          try {
            // On startup, any job stuck in 'running' is orphaned — no process from a
            // previous gateway instance is still handling it. Mark them failed immediately
            // rather than waiting for the stale timeout.
            const orphaned = db
              .prepare(`SELECT job_id FROM enrichment_jobs WHERE status='running'`)
              .all();
            for (const row of orphaned) {
              await requeueRunning(db, String(row.job_id), "gateway restarted");
              log.warn(
                `STARTUP_RECOVERY — job=${row.job_id} re-queued (orphaned from previous gateway run)`,
              );
            }
          } finally {
            db.close();
          }
        } catch (err: any) {
          log.error(`Engine DB init failed: ${String(err?.message ?? err)}`);
          return;
        }

        try {
          await api.runtime.system.runCommandWithTimeout(["openclaw", "--version"], {
            timeoutMs: 2_000,
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_CONFIG_PATH:
                process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json"),
            },
          });
        } catch (err: any) {
          log.error(`OpenClaw CLI is not available for dispatch: ${String(err?.message ?? err)}`);
          return;
        }

        log.info(
          `enrichment-engine dispatcher started (poll=${pollMs}ms stale=${Math.round(staleMs / 60_000)}min db=${engineDbPath})`,
        );

        interval = setInterval(() => {
          if (tickInFlight) {
            return;
          }
          tickInFlight = (async () => {
            let db: any | null = null;
            try {
              db = await openEngineDb();
              const state = await getQueueState(db);
              if (state.state === "running") {
                const isAdvisors = String(state.row.pipeline_id || "") === "advisors";
                const runningAgentId = String(state.row.orchestrator_agent_id || "").trim();
                if (isAdvisors && runningAgentId) {
                  const n = reconcilePendingSpecialistsFromSessions(
                    db,
                    String(state.row.job_id),
                    runningAgentId,
                  );
                  if (n > 0) {
                    log.info(
                      `RECONCILE — job=${state.row.job_id} poll marked ${n} specialist(s) DONE from session store`,
                    );
                  }
                }
                const elapsedMin = Math.floor(state.elapsedMs / 60_000);
                if (state.elapsedMs > staleMs) {
                  log.warn(
                    `STALE — job=${state.row.job_id} entity=${parseEntityLabel(state.row.entity_id)} >${Math.round(staleMs / 60_000)}min (${elapsedMin}min elapsed), marking failed`,
                  );
                  await markFailed(
                    db,
                    String(state.row.job_id),
                    `stale timeout (enrichment run exceeded ${Math.round(staleMs / 60_000)} min wall clock)`,
                  );
                  // If the orchestrator run is hung, don't block the queue behind it.
                  // We can't reliably kill the in-flight process here, but we can allow
                  // the dispatcher to proceed to the next queued job.
                  if (activeRun?.jobId === String(state.row.job_id)) {
                    log.warn(`STALE — clearing activeRun for job=${state.row.job_id}`);
                    activeRun = null;
                    dispatchCooldownUntilMs = Date.now() + 5_000;
                  }
                }
                return;
              }

              if (state.state === "queued") {
                if (activeRun) {
                  return;
                }
                const now = Date.now();
                if (now < dispatchCooldownUntilMs) {
                  return;
                }
                const row = state.row;
                const jobId = String(row.job_id);
                const agentId = String(row.orchestrator_agent_id || "").trim();
                if (!agentId) {
                  await failQueuedOrRunning(db, jobId, "missing orchestrator_agent_id");
                  return;
                }

                const cfg0 = api.runtime.config.loadConfig();
                const configuredWorkspace = String(row.orchestrator_workspace || "").trim();
                if (configuredWorkspace) {
                  await ensureAgentConfig(cfg0, agentId, configuredWorkspace);
                } else {
                  log.warn(
                    `No orchestrator_workspace configured for pipeline=${row.pipeline_id}; skipping auto agent config for agent=${agentId}`,
                  );
                }
                if (shouldResetSessionForPipeline(String(row.pipeline_id || ""))) {
                  const reset = await resetSessionBestEffort(agentId);
                  if (reset.ok && reset.reason === "reset") {
                    db.prepare(
                      `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
                       VALUES (?, 'session_reset_done', ?, NULL, datetime('now'))`,
                    ).run(jobId, "session reset completed before dispatch");
                  }
                  if (!reset.ok && reset.reason === "lock_present") {
                    db.prepare(
                      `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
                       VALUES (?, 'session_reset_deferred', ?, NULL, datetime('now'))`,
                    ).run(jobId, "session reset deferred: lock present");
                    dispatchCooldownUntilMs = Date.now() + 5_000;
                    return;
                  }
                  if (!reset.ok) {
                    db.prepare(
                      `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
                       VALUES (?, 'session_reset_deferred', ?, NULL, datetime('now'))`,
                    ).run(jobId, `session reset deferred: ${reset.reason}`);
                    dispatchCooldownUntilMs = Date.now() + 5_000;
                    return;
                  }
                } else {
                  log.info(
                    `SESSION RESET SKIP — pipeline=${row.pipeline_id} agent=${agentId} (mode=never)`,
                  );
                }

                const started = await markRunning(db, jobId);
                if (!started.ok) {
                  return;
                }

                log.info(
                  `DISPATCH — job=${jobId} pipeline=${row.pipeline_id} entity=${parseEntityLabel(row.entity_id)} agent=${agentId}`,
                );

                const run =
                  String(row.pipeline_id || "") === "advisors"
                    ? startAdvisorEnrichLoop({
                        agentId,
                        messagePrefix: String(row.message_prefix || "ENRICH"),
                        payloadJson: String(row.payload_json || ""),
                        jobId,
                        pipelineId: String(row.pipeline_id || ""),
                        entityType: String(row.entity_type || ""),
                        entityId: String(row.entity_id || ""),
                      })
                    : startAgentRun({
                        agentId,
                        messagePrefix: String(row.message_prefix || "ENRICH"),
                        payloadJson: String(row.payload_json || ""),
                        jobId,
                        pipelineId: String(row.pipeline_id || ""),
                        entityType: String(row.entity_type || ""),
                        entityId: String(row.entity_id || ""),
                      });
                activeRun = { jobId, wait: run.wait };
                run
                  .wait()
                  .then(async (result) => {
                    if (result.ok) {
                      return;
                    }
                    const db2 = await openEngineDb();
                    try {
                      await markFailed(db2, jobId, String(result.error).slice(0, 1000));
                    } finally {
                      db2.close();
                    }
                  })
                  .finally(() => {
                    activeRun = null;
                  });
                return;
              }

              const now = Date.now();
              if (now - lastIdleLogAt > 60_000) {
                lastIdleLogAt = now;
                log.debug?.("IDLE — no queued or running jobs");
              }
            } catch (err: any) {
              dispatchCooldownUntilMs = Date.now() + 30_000;
              log.error(`dispatcher error: ${String(err?.message ?? err)}`);
            } finally {
              if (db) {
                try {
                  db.close();
                } catch {}
              }
              tickInFlight = null;
            }
          })();
        }, pollMs);
        interval.unref?.();
      },
      stop: async () => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      },
    });
  },
};

export default typeof definePluginEntry === "function" ? definePluginEntry(entry) : entry;
