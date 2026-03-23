// @ts-nocheck
import fs from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Preferred modern entry helper is `definePluginEntry` from:
//   openclaw/plugin-sdk/plugin-entry
// However, some OpenClaw builds/images ship without that subpath export.
// We opportunistically use it when present, and fall back to the plain entry
// object shape (which OpenClaw also supports) for maximum compatibility.
let definePluginEntry: undefined | ((entry: any) => any);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  definePluginEntry = require("openclaw/plugin-sdk/plugin-entry")?.definePluginEntry;
} catch {}

const entry = {
  id: "advisor-lead-gen",
  name: "SEC IAPD Advisor Lead Gen",
  description: "Dispatches advisor enrichment from SQLite queue",
  register(api: any) {
    // OpenClaw places installed plugins under the runtime state directory.
    // `api.resolvePath()` is user-path resolution (~ expansion), not plugin-root resolution.
    const ROOT = join(api.runtime.state.resolveStateDir(), "extensions", "advisor-lead-gen");
    const log = api.logger;

    const DISPATCH_AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
    const POLL_INTERVAL_MS = Number.parseInt(
      process.env.ADVISOR_CRON_INTERVAL_MS || "",
      10,
    );
    const STALE_MINUTES = Number.parseInt(process.env.ADVISOR_CRON_STALE_MINUTES || "", 10);

    const pollMs =
      Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0 ? POLL_INTERVAL_MS : 5_000;
    const staleMs =
      Number.isFinite(STALE_MINUTES) && STALE_MINUTES > 0
        ? STALE_MINUTES * 60_000
        : 5 * 60_000;

    function normalizeAgentId(id: string) {
      return (id || "").trim().toLowerCase();
    }

    async function openDbForPlugin() {
      const { openDb } = await import(pathToFileURL(join(ROOT, "scripts/db.js")).href);
      const { initSchema } = await import(pathToFileURL(join(ROOT, "scripts/db-init.js")).href);
      const db = openDb(join(ROOT, "advisors.db"));
      initSchema(db);
      return db;
    }

    async function getQueueState(db: any) {
      const { dbGet } = await import(pathToFileURL(join(ROOT, "scripts/db.js")).href);
      const running = dbGet(
        db,
        `SELECT eq.id, eq.sec_id, eq.started_at, a.first_name, a.last_name
         FROM enrichment_queue eq
         LEFT JOIN advisors a USING(sec_id)
         WHERE eq.status = 'running'
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
        `SELECT eq.id, eq.sec_id, eq.advisor_json, a.first_name, a.last_name
         FROM enrichment_queue eq
         LEFT JOIN advisors a USING(sec_id)
         WHERE eq.status = 'queued'
           AND eq.advisor_json IS NOT NULL
           AND LENGTH(TRIM(eq.advisor_json)) > 0
         ORDER BY eq.queued_at ASC
         LIMIT 1`,
      );
      if (queued) {
        return { state: "queued" as const, row: queued };
      }
      return { state: "idle" as const };
    }

    async function markFailed(db: any, secId: string, error?: string) {
      db.prepare(
        `UPDATE enrichment_queue
         SET status = 'failed', completed_at = datetime('now'), error = COALESCE(?, error)
         WHERE sec_id = ? AND status = 'running'`,
      ).run(error ?? null, secId);
    }

    async function markRunning(db: any, rowId: number, secId: string) {
      const alreadyRunning = db
        .prepare(
          `SELECT sec_id FROM enrichment_queue WHERE status='running' AND sec_id != ? LIMIT 1`,
        )
        .get(secId);
      if (alreadyRunning?.sec_id) {
        return { ok: false as const, reason: "another_running" as const, secId: alreadyRunning.sec_id };
      }
      const res = db
        .prepare(
          `UPDATE enrichment_queue
           SET status='running', started_at=datetime('now')
           WHERE id=? AND status='queued'`,
        )
        .run(rowId);
      return { ok: res.changes > 0 };
    }

    function advisorLabel(row: any) {
      const name =
        [row?.first_name, row?.last_name].filter(Boolean).join(" ") || "(unknown)";
      return `sec_id=${row?.sec_id} (${name})`;
    }

    async function ensureAdvisorEnrichAgentConfig(cfg: any) {
      const wanted = normalizeAgentId(DISPATCH_AGENT_ID);
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
              id: DISPATCH_AGENT_ID,
              name: "Advisor Enrich",
              workspace: ROOT,
              model: cfg?.agents?.defaults?.model,
            },
          ],
        },
      };
      try {
        await api.runtime.config.writeConfigFile(patched);
        log.info(`Configured agent "${DISPATCH_AGENT_ID}" workspace=${ROOT}`);
      } catch (err: any) {
        log.warn(`WARN — unable to persist agent config: ${String(err?.message ?? err)}`);
      }
      return patched;
    }

    async function resetAdvisorEnrichSessionBestEffort(cfg: any) {
      try {
        const stateDir = api.runtime.state.resolveStateDir();
        const sessionsDir = join(stateDir, "agents", DISPATCH_AGENT_ID, "sessions");
        const sessionsJson = join(sessionsDir, "sessions.json");
        if (!existsSync(sessionsJson)) {
          return;
        }

        const sessionKey = `agent:${DISPATCH_AGENT_ID}:main`;
        const raw = fs.readFileSync(sessionsJson, "utf8");
        const data = JSON.parse(raw || "{}");
        const entry = data?.[sessionKey];
        const sessionId = entry?.sessionId;
        if (!sessionId) {
          return;
        }

        const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
        if (existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
          } catch {}
        }
        delete data[sessionKey];
        fs.writeFileSync(sessionsJson, JSON.stringify(data), "utf8");
        log.info(`SESSION RESET — cleared ${sessionId}`);
      } catch (err: any) {
        log.warn(`WARN — session reset failed: ${String(err?.message ?? err)}`);
      }
    }

    function startEnrichProcess(params: { advisorJson: string; secId: string }) {
      const stateDir = api.runtime.state.resolveStateDir();
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");

      const argv = [
        "openclaw",
        "agent",
        "--local",
        "--agent",
        DISPATCH_AGENT_ID,
        "--message",
        `ENRICH:${params.advisorJson}`,
        "--timeout",
        "300",
      ];
      const runPromise = api.runtime.system.runCommandWithTimeout(argv, {
        timeoutMs: 330_000,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
      });

      return {
        wait: () =>
          runPromise
            .then((r: any) => {
              if (r?.code === 0) {
                return { ok: true as const };
              }
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
              return {
                ok: false as const,
                error: `openclaw agent failed (${params.secId}): ${detail}`,
              };
            })
            .catch((err: any) => ({
              ok: false as const,
              error: `openclaw agent failed (${params.secId}): ${String(err?.message ?? err)}`,
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

      for (const rel of ["IDENTITY.md", "scripts/db.js", "scripts/db-init.js"]) {
        if (!existsSync(join(ROOT, rel))) {
          errors.push(`Missing ${rel} — reinstall the plugin.`);
        }
      }

      if (!process.env.BRAVE_API_KEY) {
        errors.push(
          'BRAVE_API_KEY not set. Run: openclaw config set env.BRAVE_API_KEY "<key>"',
        );
      }

      return errors;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let tickInFlight: Promise<void> | null = null;
    let lastIdleLogAt = 0;
    let dispatchCooldownUntilMs = 0;
    let activeRun: null | { secId: string; wait: () => Promise<any> } = null;

    api.registerService({
      id: "advisor-lead-gen-dispatcher",
      start: async () => {
        if (interval) {
          log.warn("advisor-lead-gen dispatcher already running (start ignored)");
          return;
        }
        const errors = validateSetup();
        if (errors.length > 0) {
          log.error("SETUP ERRORS — fix these and restart the gateway:");
          errors.forEach((e, i) => log.error(`  ${i + 1}. ${e}`));
          log.error(`Setup guide: ${join(ROOT, "references/SETUP_WIZARD.md")}`);
          return;
        }

        // Ensure DB schema exists up-front so the dispatcher can run immediately.
        try {
          const db = await openDbForPlugin();
          db.close();
        } catch (err: any) {
          log.error(
            `DB init failed: ${String(err?.message ?? err)} — run: cd ${ROOT} && npm run bootstrap`,
          );
          return;
        }

        // Fail fast if the gateway cannot spawn the OpenClaw CLI.
        try {
          const stateDir = api.runtime.state.resolveStateDir();
          const configPath =
            process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
          await api.runtime.system.runCommandWithTimeout(["openclaw", "--version"], {
            timeoutMs: 2_000,
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_CONFIG_PATH: configPath,
            },
          });
        } catch (err: any) {
          log.error(
            `OpenClaw CLI is not available for dispatch: ${String(err?.message ?? err)}`,
          );
          return;
        }

        // Ensure the orchestrator agent exists up-front. If it is missing, we write the config
        // once, and the gateway will restart shortly after due to plugin/config reload rules.
        try {
          const cfg0 = api.runtime.config.loadConfig();
          await ensureAdvisorEnrichAgentConfig(cfg0);
        } catch (err: any) {
          log.error(`Cannot ensure agent "${DISPATCH_AGENT_ID}": ${String(err?.message ?? err)}`);
          return;
        }

        log.info(
          `advisor-lead-gen dispatcher started (poll=${pollMs}ms stale=${Math.round(staleMs / 60_000)}min agent=${DISPATCH_AGENT_ID})`,
        );

        interval = setInterval(() => {
          if (tickInFlight) {
            return;
          }
          tickInFlight = (async () => {
            let db: any | null = null;
            try {
              db = await openDbForPlugin();
              const state = await getQueueState(db);
              if (state.state === "running") {
                const elapsedMin = Math.floor(state.elapsedMs / 60_000);
                if (state.elapsedMs > staleMs) {
                  log.warn(
                    `STALE — ${advisorLabel(state.row)} stuck >${Math.round(staleMs / 60_000)}min (${elapsedMin}min elapsed), marking failed`,
                  );
                  await markFailed(db, String(state.row.sec_id), "stale timeout");
                  db.close();
                  db = null;
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
                log.info(`DISPATCH — ${advisorLabel(row)}`);
                const rowId = Number(row.id);
                const secId = String(row.sec_id);
                const started = await markRunning(db, rowId, secId);
                if (!started.ok) {
                  if (started.reason === "another_running") {
                    log.info(`RUNNING — sec_id=${started.secId} (another enrichment active)`);
                  }
                  return;
                }

                db.close();
                db = null;
                try {
                  const cfg0 = api.runtime.config.loadConfig();
                  await resetAdvisorEnrichSessionBestEffort(cfg0);

                  const run = startEnrichProcess({
                    advisorJson: String(row.advisor_json || ""),
                    secId,
                  });
                  activeRun = { secId, wait: run.wait };
                  run
                    .wait()
                    .then(async (result) => {
                      if (result.ok) {
                        return;
                      }
                      const db2 = await openDbForPlugin();
                      try {
                        await markFailed(db2, secId, String(result.error).slice(0, 500));
                      } finally {
                        db2.close();
                      }
                    })
                    .finally(() => {
                      activeRun = null;
                    });
                } catch (err) {
                  const msg = String((err as any)?.message ?? err);
                  dispatchCooldownUntilMs = Date.now() + 30_000;
                  const db2 = await openDbForPlugin();
                  try {
                    await markFailed(db2, secId, msg.slice(0, 500));
                  } finally {
                    db2.close();
                  }
                  throw err;
                }
                return;
              }

              const now = Date.now();
              if (now - lastIdleLogAt > 60_000) {
                lastIdleLogAt = now;
                log.debug?.("IDLE — nothing queued or running");
              }
            } catch (err: any) {
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
