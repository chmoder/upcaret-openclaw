// @ts-nocheck
import fs, { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let definePluginEntry: undefined | ((entry: any) => any);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  definePluginEntry =
    require("openclaw/plugin-sdk/plugin-entry")?.definePluginEntry;
} catch {}

const entry = {
  id: "enrichment",
  name: "upCaret Enrichment",
  description: "Standalone profile enrichment queue dispatcher",
  register(api: any) {
    const stateDir = api.runtime.state.resolveStateDir();
    const linkedRoot = fileURLToPath(new URL(".", import.meta.url));
    const installedRoot = join(stateDir, "extensions", "enrichment");
    const ROOT = existsSync(join(linkedRoot, "scripts", "db.js"))
      ? linkedRoot
      : installedRoot;
    const log = api.logger;

    function normalizeAgentId(id: string) {
      return (id || "").trim().toLowerCase();
    }

    // Auto-register the enrichment orchestrator agent on startup.
    async function ensureEnrichmentOrchestratorAgent() {
      const desiredId = "profile-enrich";
      let cfg: any = {};
      try {
        cfg = api.runtime.config.loadConfig() ?? {};
      } catch {
        cfg = {};
      }
      const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
      const idx = list.findIndex(
        (a: any) => normalizeAgentId(String(a?.id || "")) === desiredId,
      );
      const desiredEntry = (base: any = {}) => {
        const entry: any = {
          ...base,
          id: desiredId,
          name: base.name ?? "Profile Enrich",
          workspace: ROOT,
          model: base.model ?? cfg?.agents?.defaults?.model,
        };
        delete entry.tools;
        return entry;
      };
      if (idx >= 0) {
        const existing = list[idx] ?? {};
        if (existing.workspace === ROOT && !("tools" in existing)) return;
      }
      const patchedList =
        idx === -1
          ? [...list, desiredEntry()]
          : list.map((a: any, i: number) => (i === idx ? desiredEntry(a) : a));
      const patched = {
        ...cfg,
        agents: { ...(cfg?.agents ?? {}), list: patchedList },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(`Configured enrichment orchestrator agent "${desiredId}" (workspace=${ROOT})`);
    }

    void ensureEnrichmentOrchestratorAgent().catch((err: any) => {
      log.warn(`WARN — unable to auto-configure profile-enrich agent: ${String(err?.message ?? err)}`);
    });

    const POLL_INTERVAL_MS = Number.parseInt(
      process.env.ENRICH_ENGINE_INTERVAL_MS || "",
      10,
    );
    const STALE_MINUTES = Number.parseInt(
      process.env.ENRICH_ENGINE_STALE_MINUTES || "",
      10,
    );
    const pollMs =
      Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0
        ? POLL_INTERVAL_MS
        : 5_000;
    const staleMs =
      Number.isFinite(STALE_MINUTES) && STALE_MINUTES > 0
        ? STALE_MINUTES * 60_000
        : 10 * 60_000;
    const enrichmentDbPath =
      process.env.ENRICHMENT_DB_PATH ||
      join(api.runtime.state.resolveStateDir(), "enrichment", "enrichment.db");

    async function openEnrichmentDb() {
      const dir = join(enrichmentDbPath, "..");
      fs.mkdirSync(dir, { recursive: true });
      const { openDb } = await import(pathToFileURL(join(ROOT, "scripts/db.js")).href);
      const { initSchema } = await import(
        pathToFileURL(join(ROOT, "scripts/db-init.js")).href
      );
      const db = openDb(enrichmentDbPath);
      initSchema(db);
      return db;
    }

    async function getQueueState(db: any) {
      const running = db
        .prepare(
          `SELECT job_id, profile_id, payload_json, orchestrator_agent_id, orchestrator_workspace,
                  message_prefix, started_at
           FROM enrichment_jobs
           WHERE status='running'
           ORDER BY started_at ASC
           LIMIT 1`,
        )
        .get();
      if (running) {
        const startedMs = running.started_at
          ? new Date(
              String(running.started_at).includes("T")
                ? String(running.started_at)
                : `${String(running.started_at).replace(" ", "T")}Z`,
            ).getTime()
          : Date.now();
        return {
          state: "running" as const,
          row: running,
          elapsedMs: Date.now() - startedMs,
        };
      }

      const queued = db
        .prepare(
          `SELECT job_id, profile_id, payload_json, orchestrator_agent_id, orchestrator_workspace, message_prefix
           FROM enrichment_jobs
           WHERE status='queued'
             AND payload_json IS NOT NULL
             AND LENGTH(TRIM(payload_json)) > 0
           ORDER BY priority DESC, queued_at ASC
           LIMIT 1`,
        )
        .get();
      if (queued) return { state: "queued" as const, row: queued };
      return { state: "idle" as const };
    }

    async function markFailed(db: any, jobId: string, error?: string) {
      db.prepare(
        `UPDATE enrichment_jobs
         SET status='failed', completed_at=datetime('now'), error=COALESCE(?, error)
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
         SET status='failed', completed_at=datetime('now'), error=COALESCE(?, error)
         WHERE job_id = ? AND status IN ('queued','running')`,
      ).run(error ?? null, jobId);
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, 'job_failed', ?, NULL, datetime('now'))`,
      ).run(jobId, String(error || "job failed"));
    }

    async function markRunning(db: any, jobId: string) {
      const alreadyRunning = db
        .prepare(
          `SELECT job_id
           FROM enrichment_jobs
           WHERE status='running' AND job_id != ?
           LIMIT 1`,
        )
        .get(jobId);
      if (alreadyRunning?.job_id) {
        return { ok: false as const, reason: "another_running" as const };
      }
      const res = db
        .prepare(
          `UPDATE enrichment_jobs
           SET status='running', started_at=datetime('now'), attempt_count=attempt_count+1
           WHERE job_id=? AND status='queued'`,
        )
        .run(jobId);
      return { ok: res.changes > 0 };
    }

    async function ensureSubagentChildrenLimit(cfg: any) {
      const current = Number(
        cfg?.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5,
      );
      if (Number.isFinite(current) && current >= 10) {
        return { applied: false as const, cfg };
      }
      const patched = {
        ...cfg,
        agents: {
          ...(cfg?.agents ?? {}),
          defaults: {
            ...(cfg?.agents?.defaults ?? {}),
            subagents: {
              ...(cfg?.agents?.defaults?.subagents ?? {}),
              maxChildrenPerAgent: 12,
            },
          },
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      return { applied: true as const, cfg: patched };
    }

    async function ensureAgentConfig(cfg: any, agentId: string, workspacePath: string) {
      const wanted = normalizeAgentId(agentId);
      if (!wanted) return cfg;
      const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];

      const existingIdx = list.findIndex(
        (a: any) => normalizeAgentId(String(a?.id || "")) === wanted,
      );

      const desiredEntry = (base: any = {}) => {
        const entry: any = {
          ...base,
          id: agentId,
          name: base.name ?? `Enrichment: ${agentId}`,
          workspace: workspacePath,
          model: base.model ?? cfg?.agents?.defaults?.model,
        };
        // Avoid (or remove) per-agent tools allowlists; they are exclusive and can
        // break required tools (and do not reliably enable the built-in browser).
        delete entry.tools;
        return entry;
      };

      let newList: any[];
      if (existingIdx === -1) {
        newList = [...list, desiredEntry()];
      } else {
        const existing = list[existingIdx] ?? {};
        const needsUpdate =
          existing.workspace !== workspacePath || "tools" in existing;
        if (!needsUpdate) return cfg;
        newList = list.map((a, i) => (i === existingIdx ? desiredEntry(a) : a));
      }

      const patched = {
        ...cfg,
        agents: {
          ...(cfg?.agents ?? {}),
          list: newList,
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      return patched;
    }

    async function ensureBrowserConfig(cfg: any) {
      const allowHostControl =
        cfg?.agents?.defaults?.sandbox?.browser?.allowHostControl;
      const headless = cfg?.browser?.headless;
      const currentProfile = cfg?.tools?.profile ?? "coding";
      const profileIsFull = currentProfile === "full";

      // The built-in `browser` tool is in the UI toolgroup. The "coding" profile
      // excludes UI tools, which prevents specialists spawned by the orchestrator
      // from using browser navigation/snapshots. Promoting to tools.profile="full"
      // makes browser available to all agents (including spawned specialists).
      if (allowHostControl === true && headless === true && profileIsFull) {
        return { applied: false as const, cfg };
      }

      const patched: any = {
        ...cfg,
        browser: {
          ...(cfg?.browser ?? {}),
          headless: true,
        },
        tools: {
          ...(cfg?.tools ?? {}),
          profile: "full",
        },
        agents: {
          ...(cfg?.agents ?? {}),
          defaults: {
            ...(cfg?.agents?.defaults ?? {}),
            sandbox: {
              ...(cfg?.agents?.defaults?.sandbox ?? {}),
              browser: {
                ...(cfg?.agents?.defaults?.sandbox?.browser ?? {}),
                allowHostControl: true,
              },
            },
          },
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      return { applied: true as const, cfg: patched };
    }

    async function resetSessionBestEffort(agentId: string) {
      try {
        const sessionsDir = join(stateDir, "agents", agentId, "sessions");
        const sessionsJson = join(sessionsDir, "sessions.json");
        if (!existsSync(sessionsJson)) return { ok: true as const };
        const files = fs.readdirSync(sessionsDir);
        if (files.some((f) => f.endsWith(".lock"))) {
          return { ok: false as const, reason: "lock_present" as const };
        }

        const sessionKey = `agent:${agentId}:main`;
        const raw = fs.readFileSync(sessionsJson, "utf8");
        const data = JSON.parse(raw || "{}");
        const sessionId = data?.[sessionKey]?.sessionId;
        if (!sessionId) return { ok: true as const };

        const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
        if (existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
          } catch {}
        }
        delete data[sessionKey];
        fs.writeFileSync(sessionsJson, JSON.stringify(data), "utf8");
        return { ok: true as const };
      } catch (err: any) {
        log.warn(`WARN — session reset failed: ${String(err?.message ?? err)}`);
        return { ok: false as const, reason: "error" as const };
      }
    }

    function agentRunEnv(params: { jobId: string; profileId: string }) {
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      return {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        ENRICHMENT_DB_PATH: enrichmentDbPath,
        ENRICHMENT_ENGINE_WORKSPACE: ROOT,
        ENRICHMENT_JOB_ID: params.jobId,
        ENRICHMENT_PROFILE_ID: params.profileId,
      };
    }

    function formatAgentFailure(jobId: string, r: any) {
      const stdout = String(r?.stdout ?? "").trim();
      const stderr = String(r?.stderr ?? "").trim();
      const detail = [
        r?.termination ? `termination=${r.termination}` : null,
        r?.code != null ? `exit=${r.code}` : null,
        r?.signal ? `signal=${r.signal}` : null,
        stderr ? `stderr=${stderr.slice(0, 4000)}` : null,
        stdout ? `stdout=${stdout.slice(0, 4000)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      return `openclaw agent failed (job=${jobId}): ${detail}`;
    }

    function reconcilePendingSpecialistsFromSessions(db: any, jobId: string, agentId: string): number {
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
        const st = String(map?.[key]?.status || "").toLowerCase();
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

    function startEnrichLoop(params: {
      agentId: string;
      messagePrefix: string;
      payloadJson: string;
      jobId: string;
      profileId: string;
    }) {
      const turnSecRaw = Number.parseInt(process.env.ENRICH_TURN_TIMEOUT_SEC || "", 10);
      const turnSec = Number.isFinite(turnSecRaw) && turnSecRaw >= 60 ? turnSecRaw : 300;
      const maxTicksRaw = Number.parseInt(process.env.ENRICH_MAX_TICKS || "", 10);
      const maxTicks = Number.isFinite(maxTicksRaw) && maxTicksRaw > 0 ? maxTicksRaw : 40;
      const pauseMsRaw = Number.parseInt(process.env.ENRICH_TICK_PAUSE_MS || "", 10);
      const pauseMs = Number.isFinite(pauseMsRaw) && pauseMsRaw >= 0 ? pauseMsRaw : 4_000;
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
            db0 = await openEnrichmentDb();
            const row = db0
              .prepare(`SELECT status FROM enrichment_jobs WHERE job_id = ?`)
              .get(params.jobId);
            if (!row || row.status !== "running") {
              if (row?.status === "done") return { ok: true as const };
              return {
                ok: false as const,
                error: `enrich stopped: job ${params.jobId} not running (status=${row?.status ?? "missing"})`,
              };
            }
            reconcilePendingSpecialistsFromSessions(db0, params.jobId, params.agentId);
          } finally {
            if (db0) {
              try {
                db0.close();
              } catch {}
            }
          }

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
            env,
          });
          if (phase === "enrich") enrichStdout += String(r?.stdout ?? "");
          else completeStdout += String(r?.stdout ?? "");

          if (enrichStdout.includes("DONE:") || completeStdout.includes("DONE:")) {
            return { ok: true as const };
          }

          if (phase === "enrich" && enrichStdout.includes("ALL_SPECIALISTS_DONE:")) {
            await resetSessionBestEffort(params.agentId);
            await new Promise((res) => setTimeout(res, 2_000));
            phase = "complete";
            completeStdout = "";
          } else if (phase === "complete" && completeStdout.includes("SCORE_SPAWNED:")) {
            phase = "complete_tick";
          }

          if (r?.code !== 0 && i === maxTicks - 1) {
            return {
              ok: false as const,
              error: formatAgentFailure(params.jobId, r),
            };
          }
          if (i < maxTicks - 1 && pauseMs > 0) {
            await new Promise((res) => setTimeout(res, pauseMs));
          }
        }
        return {
          ok: false as const,
          error: `enrich exceeded ${maxTicks} turns without DONE: (job=${params.jobId})`,
        };
      })();

      return {
        wait: () =>
          runPromise
            .then((out: any) => out)
            .catch((err: any) => ({
              ok: false as const,
              error: `enrich loop failed (job=${params.jobId}): ${String(err?.message ?? err)}`,
            })),
      };
    }

    function validateInstallLayout(): string[] {
      const errors: string[] = [];
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 5)) {
        errors.push(
          `Node ${process.versions.node} is too old — requires 22.5+. Upgrade: https://nodejs.org`,
        );
      }
      for (const rel of ["scripts/db.js", "scripts/db-init.js"]) {
        if (!existsSync(join(ROOT, rel))) {
          errors.push(`Missing ${rel} — reinstall enrichment.`);
        }
      }
      return errors;
    }

    function validateGatewayConfig(cfg: any): string[] {
      const errors: string[] = [];
      const maxChildren = Number(
        cfg?.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5,
      );
      if (!Number.isFinite(maxChildren) || maxChildren < 10) {
        errors.push(
          "agents.defaults.subagents.maxChildrenPerAgent must be >= 10 (orchestrator spawns 10 specialists). Auto-applied on startup — if this persists: openclaw config set agents.defaults.subagents.maxChildrenPerAgent 12 && openclaw gateway restart",
        );
      }

      if (
        cfg?.agents?.defaults?.sandbox?.browser?.allowHostControl !== true ||
        cfg?.browser?.headless !== true ||
        cfg?.tools?.profile !== "full"
      ) {
        errors.push(
          'browser.headless, agents.defaults.sandbox.browser.allowHostControl, and tools.profile="full" must all be set. Auto-configured on startup — if this error persists, restart the gateway once more.',
        );
      }

      return errors;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let tickInFlight: Promise<void> | null = null;
    let activeRun: null | { jobId: string; wait: () => Promise<any> } = null;
    let dispatchCooldownUntilMs = 0;
    let lastIdleLogAt = 0;

    api.registerService({
      id: "enrichment-dispatcher",
      start: async () => {
        if (interval) return;

        let cfgForValidate: any = {};
        try {
          cfgForValidate = api.runtime.config.loadConfig() ?? {};
        } catch {
          cfgForValidate = {};
        }

        const layoutErrors = validateInstallLayout();
        if (layoutErrors.length > 0) {
          log.error("SETUP ERRORS — fix these and restart gateway:");
          layoutErrors.forEach((e, i) => log.error(`  ${i + 1}. ${e}`));
          return;
        }

        try {
          const out = await ensureSubagentChildrenLimit(cfgForValidate);
          cfgForValidate = out.cfg;
          if (out.applied) {
            log.error(
              "Applied agents.defaults.subagents.maxChildrenPerAgent=12 for enrichment (10 specialist spawns). Restart gateway to apply.",
            );
            return;
          }
        } catch (err: any) {
          log.warn(
            `WARN — unable to auto-apply maxChildrenPerAgent: ${String(err?.message ?? err)}`,
          );
        }

        try {
          const out = await ensureBrowserConfig(cfgForValidate);
          cfgForValidate = out.cfg;
          if (out.applied) {
            log.error(
              'Configured browser prerequisites (browser.headless=true, agents.defaults.sandbox.browser.allowHostControl=true, tools.profile="full"). Restart gateway to apply.',
            );
            return;
          }
        } catch (err: any) {
          log.warn(
            `WARN — unable to auto-configure browser settings: ${String(err?.message ?? err)}`,
          );
        }

        const configErrors = validateGatewayConfig(cfgForValidate);
        if (configErrors.length > 0) {
          log.error("SETUP ERRORS — fix these and restart gateway:");
          configErrors.forEach((e, i) => log.error(`  ${i + 1}. ${e}`));
          return;
        }

        try {
          const db = await openEnrichmentDb();
          try {
            const orphaned = db
              .prepare(`SELECT job_id FROM enrichment_jobs WHERE status='running'`)
              .all();
            for (const row of orphaned) {
              await markFailed(db, String(row.job_id), "gateway restarted");
            }
          } finally {
            db.close();
          }
        } catch (err: any) {
          log.error(`DB init failed: ${String(err?.message ?? err)}`);
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
          `enrichment dispatcher started (poll=${pollMs}ms stale=${Math.round(staleMs / 60_000)}min db=${enrichmentDbPath})`,
        );

        interval = setInterval(() => {
          if (tickInFlight) return;
          tickInFlight = (async () => {
            let db: any | null = null;
            try {
              db = await openEnrichmentDb();
              const state = await getQueueState(db);

              if (state.state === "running") {
                const runningAgentId = String(state.row.orchestrator_agent_id || "").trim();
                if (runningAgentId) {
                  reconcilePendingSpecialistsFromSessions(
                    db,
                    String(state.row.job_id),
                    runningAgentId,
                  );
                }
                if (state.elapsedMs > staleMs) {
                  await markFailed(
                    db,
                    String(state.row.job_id),
                    `stale timeout (${Math.round(staleMs / 60_000)} min)`,
                  );
                  if (activeRun?.jobId === String(state.row.job_id)) {
                    activeRun = null;
                    dispatchCooldownUntilMs = Date.now() + 5_000;
                  }
                }
                return;
              }

              if (state.state === "queued") {
                if (activeRun) return;
                if (Date.now() < dispatchCooldownUntilMs) return;

                const row = state.row;
                const jobId = String(row.job_id);
                const agentId = String(
                  row.orchestrator_agent_id || process.env.ENRICH_ORCH_AGENT_ID || "profile-enrich",
                ).trim();
                if (!agentId) {
                  await failQueuedOrRunning(db, jobId, "missing orchestrator_agent_id");
                  return;
                }

                let cfg0 = api.runtime.config.loadConfig();
                try {
                  const outLimit = await ensureSubagentChildrenLimit(cfg0);
                  cfg0 = outLimit.cfg;
                  if (outLimit.applied) {
                    log.error(
                      "Applied agents.defaults.subagents.maxChildrenPerAgent=12. Restart gateway to apply.",
                    );
                    dispatchCooldownUntilMs = Date.now() + 30_000;
                    return;
                  }
                } catch (err: any) {
                  log.warn(
                    `WARN — unable to auto-apply maxChildrenPerAgent: ${String(err?.message ?? err)}`,
                  );
                }
                try {
                  const out = await ensureBrowserConfig(cfg0);
                  cfg0 = out.cfg;
                  if (out.applied) {
                    log.error(
                      'Configured browser prerequisites (browser.headless=true, agents.defaults.sandbox.browser.allowHostControl=true, tools.profile="full"). Restart gateway to apply.',
                    );
                    dispatchCooldownUntilMs = Date.now() + 30_000;
                    return;
                  }
                } catch (err: any) {
                  log.warn(
                    `WARN — unable to auto-configure browser settings: ${String(err?.message ?? err)}`,
                  );
                }
                const configuredWorkspace = String(
                  row.orchestrator_workspace || process.env.ENRICHMENT_WORKSPACE || ROOT,
                ).trim();
                await ensureAgentConfig(cfg0, agentId, configuredWorkspace);

                const reset = await resetSessionBestEffort(agentId);
                if (!reset.ok && reset.reason === "lock_present") {
                  dispatchCooldownUntilMs = Date.now() + 5_000;
                  return;
                }

                const started = await markRunning(db, jobId);
                if (!started.ok) return;

                const run = startEnrichLoop({
                  agentId,
                  messagePrefix: String(row.message_prefix || "ENRICH"),
                  payloadJson: String(row.payload_json || ""),
                  jobId,
                  profileId: String(row.profile_id || ""),
                });
                activeRun = { jobId, wait: run.wait };
                run
                  .wait()
                  .then(async (result) => {
                    if (result.ok) return;
                    const db2 = await openEnrichmentDb();
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

              if (Date.now() - lastIdleLogAt > 60_000) {
                lastIdleLogAt = Date.now();
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

export default typeof definePluginEntry === "function"
  ? definePluginEntry(entry)
  : entry;
