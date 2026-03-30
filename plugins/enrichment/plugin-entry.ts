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

    function readFullConfig() {
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      try {
        return JSON.parse(fs.readFileSync(configPath, "utf8") || "{}");
      } catch {
        return {};
      }
    }

    async function ensureTrustedPluginsAllow() {
      const trusted = ["enrichment", "profile-research", "sec-iapd"];
      const cfg: any = readFullConfig();
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return;
      }
      const allow0 = Array.isArray(cfg?.plugins?.allow)
        ? cfg.plugins.allow
        : [];
      const allow = Array.from(
        new Set([...allow0.map(String), ...trusted.map(String)]),
      );
      const same =
        allow.length === allow0.length &&
        allow.every((id: any, i: number) => String(id) === String(allow0[i]));
      if (same) return;

      const patched = {
        ...cfg,
        plugins: {
          ...(cfg?.plugins ?? {}),
          allow,
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(`Pinned plugins.allow: ${allow.join(", ")}`);
    }

    const ENRICHMENT_ORCH_AGENT_ID = "profile-enrich";
    // IDs must match `IDENTITY.md` sessions_spawn targets.
    const ENRICHMENT_CHILD_AGENT_SPECS = [
      { id: "enrich-profile", label: "profile" },
      { id: "enrich-email", label: "email" },
      { id: "enrich-phone", label: "phone" },
      { id: "enrich-website", label: "website" },
      { id: "enrich-linkedin", label: "linkedin" },
      { id: "enrich-cert", label: "cert" },
      { id: "enrich-award", label: "award" },
      { id: "enrich-speaking", label: "speaking" },
      { id: "enrich-news", label: "news" },
      { id: "enrich-network", label: "network" },
      { id: "enrich-scorer", label: "scorer" },
    ] as const;
    const ENRICHMENT_CHILD_AGENT_IDS = ENRICHMENT_CHILD_AGENT_SPECS.map((s) => s.id);

    async function ensureEnrichmentAgents() {
      const cfg: any = readFullConfig();
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return;
      }
      const list: any[] = Array.isArray(cfg?.agents?.list)
        ? cfg.agents.list
        : [];
      const newList = [...list];
      let changed = false;

      const upsertAgent = (desiredId: string, defaultName: string) => {
        const wanted = normalizeAgentId(desiredId);
        const idx = newList.findIndex(
          (a: any) => normalizeAgentId(String(a?.id || "")) === wanted,
        );
        const desiredEntry = (base: any = {}) => {
          const entry: any = {
            ...base,
            id: desiredId,
            name: base.name ?? defaultName,
            workspace: ROOT,
            model: base.model ?? cfg?.agents?.defaults?.model,
          };
          delete entry.tools;
          return entry;
        };
        if (idx >= 0) {
          const existing = newList[idx] ?? {};
          const merged = desiredEntry(existing);
          const allow0 = Array.isArray(existing?.subagents?.allowAgents)
            ? existing.subagents.allowAgents.map(String)
            : [];
          const allowAgents = Array.from(
            new Set([...allow0, ...ENRICHMENT_CHILD_AGENT_IDS]),
          );
          if (desiredId === ENRICHMENT_ORCH_AGENT_ID) {
            merged.subagents = {
              ...(existing?.subagents ?? {}),
              allowAgents,
            };
          }
          if (
            JSON.stringify(existing) !== JSON.stringify(merged) ||
            (desiredId === ENRICHMENT_ORCH_AGENT_ID && allow0.length !== allowAgents.length)
          ) {
            newList[idx] = merged;
            changed = true;
          }
          return;
        }

        const created = desiredEntry();
        if (desiredId === ENRICHMENT_ORCH_AGENT_ID) {
          created.subagents = {
            allowAgents: [...ENRICHMENT_CHILD_AGENT_IDS],
          };
        }
        newList.push(created);
        changed = true;
      };

      upsertAgent(ENRICHMENT_ORCH_AGENT_ID, "Profile Enrich");
      for (const spec of ENRICHMENT_CHILD_AGENT_SPECS) {
        upsertAgent(spec.id, `Enrichment: ${spec.label}`);
      }

      if (!changed) return;
      const patched = {
        ...cfg,
        agents: { ...(cfg?.agents ?? {}), list: newList },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(
        `Configured enrichment agents (orchestrator + ${ENRICHMENT_CHILD_AGENT_IDS.length} child agents) workspace=${ROOT}`,
      );
    }

    function makeWorkspaceShimScript(scriptName: string) {
      return `#!/usr/bin/env node
// openclaw-managed: enrichment-consumer-shim v2
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const scriptName = ${JSON.stringify(scriptName)};
const candidates = [
  process.env.ENRICHMENT_WORKSPACE
    ? path.join(process.env.ENRICHMENT_WORKSPACE, "scripts", scriptName)
    : null,
  process.env.OPENCLAW_HOME
    ? path.join(process.env.OPENCLAW_HOME, "extensions", "enrichment", "scripts", scriptName)
    : null,
  path.resolve(__dirname, "..", "..", "extensions", "enrichment", "scripts", scriptName),
].filter(Boolean);
const target = candidates.find((p) => fs.existsSync(p));
if (!target) {
  console.error("ERROR: enrichment script not found for " + scriptName);
  process.exit(1);
}
const out = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
if (out.error) {
  console.error("ERROR:" + String(out.error.message || out.error));
  process.exit(1);
}
process.exit(typeof out.status === "number" ? out.status : 1);
`;
    }

    async function ensureWorkspaceConsumerScripts(cfg: any) {
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return;
      }
      const workspace = String(
        cfg?.agents?.defaults?.workspace || join(stateDir, "workspace"),
      ).trim() || join(stateDir, "workspace");
      const scriptsDir = join(workspace, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });

      const shims = [
        { name: "save-profiles.js" },
        { name: "enqueue.js" },
      ];
      const written: string[] = [];
      for (const shim of shims) {
        const outPath = join(scriptsDir, shim.name);
        const next = makeWorkspaceShimScript(shim.name);
        const marker = "openclaw-managed: enrichment-consumer-shim";
        if (existsSync(outPath)) {
          try {
            const existing = fs.readFileSync(outPath, "utf8");
            if (!existing.includes(marker)) {
              log.warn(
                `Workspace shim not installed (existing unmanaged file): ${outPath}`,
              );
              continue;
            }
            if (existing === next) continue;
          } catch {}
        }
        fs.writeFileSync(outPath, next, "utf8");
        try {
          fs.chmodSync(outPath, 0o755);
        } catch {}
        written.push(outPath);
      }
      if (written.length > 0) {
        log.info(`Installed workspace consumer shims: ${written.join(", ")}`);
      }
    }

    void (async () => {
      await ensureTrustedPluginsAllow();
      await ensureEnrichmentAgents();
      await ensureWorkspaceConsumerScripts(readFullConfig());
    })().catch((err: any) => {
      log.warn(
        `WARN — unable to auto-configure enrichment startup config: ${String(err?.message ?? err)}`,
      );
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
      const { openDb } = await import(
        pathToFileURL(join(ROOT, "scripts/db.js")).href
      );
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
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return { applied: false as const, cfg };
      }
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

    async function ensureAgentConfig(
      cfg: any,
      agentId: string,
      workspacePath: string,
    ) {
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return cfg;
      }
      const wanted = normalizeAgentId(agentId);
      if (!wanted) return cfg;
      const list: any[] = Array.isArray(cfg?.agents?.list)
        ? cfg.agents.list
        : [];

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
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return { applied: false as const, cfg };
      }
      const allowHostControl =
        cfg?.agents?.defaults?.sandbox?.browser?.allowHostControl;
      const browserSandboxEnabled =
        cfg?.agents?.defaults?.sandbox?.browser?.enabled;
      const headless = cfg?.browser?.headless;
      const currentProfile = cfg?.tools?.profile ?? "coding";
      const profileIsFull = currentProfile === "full";

      if (
        allowHostControl === true &&
        browserSandboxEnabled === true &&
        headless === true &&
        profileIsFull
      ) {
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
                enabled: true,
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

    function agentRunEnv(params: {
      jobId: string;
      profileId: string;
      workspacePath: string;
    }) {
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      const workspacePath =
        String(params.workspacePath || "").trim() || ROOT;
      return {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        ENRICHMENT_WORKSPACE: workspacePath,
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

    function parseChildSessionKey(rawKey: string) {
      const key = String(rawKey || "").trim();
      const m = key.match(/^agent:([^:]+):subagent:([^:]+)$/);
      if (!m) return null;
      return { key, childAgentId: m[1], subagentId: m[2] };
    }

    function extractJsonFromMarkdown(text: string) {
      if (typeof text !== "string") return null;
      const m = text.match(/```json\s*([\s\S]*?)```/);
      if (!m) return null;
      try {
        return JSON.parse(m[1].trim());
      } catch {
        return null;
      }
    }

    function parseFinalSpecialistResultJson(jsonlPath: string) {
      try {
        if (!existsSync(jsonlPath)) return null;
        const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
        let lastParsed: any = null;
        for (const ln of lines) {
          let ev: any = null;
          try {
            ev = JSON.parse(ln);
          } catch {
            continue;
          }
          if (
            ev?.type === "message" &&
            ev?.message?.role === "assistant" &&
            Array.isArray(ev?.message?.content)
          ) {
            for (const c of ev.message.content) {
              if (c?.type !== "text" || typeof c?.text !== "string") continue;
              const parsed = parseJsonObjectFromText(c.text);
              if (parsed && typeof parsed === "object") lastParsed = parsed;
            }
          }
        }
        return lastParsed ? JSON.stringify(lastParsed) : null;
      } catch {
        return null;
      }
    }

    function insertEnrichmentEvent(
      db: any,
      params: {
        jobId: string;
        eventType: string;
        message: string;
        context?: Record<string, any>;
        dedupe?: boolean;
      },
    ) {
      const contextJson = params.context ? JSON.stringify(params.context) : null;
      if (params.dedupe) {
        const exists = db
          .prepare(
            `SELECT 1
             FROM enrichment_events
             WHERE job_id=?
               AND event_type=?
               AND message=?
               AND COALESCE(context_json,'')=COALESCE(?,'')
             LIMIT 1`,
          )
          .get(params.jobId, params.eventType, params.message, contextJson);
        if (exists) return;
      }
      db.prepare(
        `INSERT INTO enrichment_events (job_id, event_type, message, context_json, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(params.jobId, params.eventType, params.message, contextJson);
    }

    function parseSqliteDateToMs(value: any) {
      const s = String(value || "").trim();
      if (!s) return null;
      const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? ms : null;
    }

    function parseSpecialistNameFromTask(task: string) {
      const m = String(task || "").match(/#\s*([A-Za-z]+)\s+Specialist/i);
      if (!m) return null;
      const raw = String(m[1] || "").trim().toLowerCase();
      const map: Record<string, string> = {
        profile: "profile",
        email: "email",
        phone: "phone",
        website: "website",
        linkedin: "linkedin",
        certification: "cert",
        cert: "cert",
        award: "award",
        speaking: "speaking",
        news: "news",
        network: "network",
      };
      return map[raw] || null;
    }

    function seedSpecialistRunsFromLedger(
      db: any,
      params: { jobId: string; profileId: string; agentId: string; startedAt?: any },
    ) {
      const runsPath = join(stateDir, "subagents", "runs.json");
      if (!existsSync(runsPath)) return 0;
      const startedMs = parseSqliteDateToMs(params.startedAt);
      let root: any = null;
      try {
        root = JSON.parse(fs.readFileSync(runsPath, "utf8") || "{}");
      } catch {
        return 0;
      }
      const allRuns: any[] = Object.values(root?.runs || {});
      if (allRuns.length === 0) return 0;
      const controllerSessionKey = `agent:${params.agentId}:main`;
      const bySpecialist = new Map<string, { childSessionKey: string; createdAt: number }>();
      for (const r of allRuns) {
        const childSessionKey = String(r?.childSessionKey || "").trim();
        const task = String(r?.task || "");
        if (!childSessionKey || !task) continue;
        if (String(r?.controllerSessionKey || "") !== controllerSessionKey) continue;
        if (!task.includes(`"profile_id":"${params.profileId}"`)) continue;
        const specialist = parseSpecialistNameFromTask(task);
        if (!specialist) continue;
        const createdAt = Number(r?.createdAt || 0);
        if (startedMs && Number.isFinite(createdAt) && createdAt < startedMs - 30_000) {
          continue;
        }
        const prev = bySpecialist.get(specialist);
        if (!prev || createdAt > prev.createdAt) {
          bySpecialist.set(specialist, {
            childSessionKey,
            createdAt: Number.isFinite(createdAt) ? createdAt : 0,
          });
        }
      }
      if (bySpecialist.size === 0) return 0;

      const existingRows = db
        .prepare(
          `SELECT specialist_name
           FROM enrichment_specialist_runs
           WHERE job_id = ?`,
        )
        .all(params.jobId);
      const existing = new Set(
        existingRows.map((r: any) => String(r?.specialist_name || "").trim()),
      );

      let inserted = 0;
      for (const [specialist, info] of bySpecialist.entries()) {
        if (existing.has(specialist)) continue;
        db.prepare(
          `INSERT INTO enrichment_specialist_runs (
             job_id, specialist_name, child_session_key, status, spawned_at
           ) VALUES (?, ?, ?, 'PENDING', datetime('now'))`,
        ).run(params.jobId, specialist, info.childSessionKey);
        inserted++;
      }
      if (inserted > 0) {
        insertEnrichmentEvent(db, {
          jobId: params.jobId,
          eventType: "specialist_seeded_from_ledger",
          message: `seeded ${inserted} specialist rows from subagent runs ledger`,
          context: {
            profile_id: params.profileId,
            controller_session_key: controllerSessionKey,
          },
          dedupe: false,
        });
      }
      return inserted;
    }

    function reconcilePendingSpecialistsFromSessions(
      db: any,
      jobId: string,
      agentId: string,
    ): number {
      void agentId; // hard cutover: use child session key agent id only
      const sessionsCache = new Map<
        string,
        { ok: true; map: Record<string, any>; sessionsDir: string } | { ok: false; reason: string; sessionsJsonPath: string }
      >();
      const pending = db
        .prepare(
          `SELECT specialist_name, child_session_key
           FROM enrichment_specialist_runs
           WHERE job_id = ?
             AND status = 'PENDING'`,
        )
        .all(jobId);
      let n = 0;
      for (const row of pending) {
        const key = String(row.child_session_key || "").trim();
        const specialist = String(row.specialist_name || "").trim();
        const parsedKey = parseChildSessionKey(key);
        if (!parsedKey) {
          insertEnrichmentEvent(db, {
            jobId,
            eventType: "reconcile_invalid_child_session_key",
            message: `invalid child_session_key for specialist=${specialist}`,
            context: {
              specialist,
              child_session_key: key || null,
            },
            dedupe: true,
          });
          continue;
        }

        let cached = sessionsCache.get(parsedKey.childAgentId);
        if (!cached) {
          const sessionsDir = join(stateDir, "agents", parsedKey.childAgentId, "sessions");
          const sessionsJsonPath = join(sessionsDir, "sessions.json");
          if (!existsSync(sessionsJsonPath)) {
            cached = { ok: false, reason: "missing_sessions_json", sessionsJsonPath };
          } else {
            try {
              const raw = fs.readFileSync(sessionsJsonPath, "utf8");
              cached = {
                ok: true,
                map: JSON.parse(raw || "{}"),
                sessionsDir,
              };
            } catch {
              cached = { ok: false, reason: "invalid_sessions_json", sessionsJsonPath };
            }
          }
          sessionsCache.set(parsedKey.childAgentId, cached);
        }
        if (!cached.ok) {
          insertEnrichmentEvent(db, {
            jobId,
            eventType: "reconcile_sessions_unavailable",
            message: `sessions map unavailable for child_agent_id=${parsedKey.childAgentId}`,
            context: {
              specialist,
              child_agent_id: parsedKey.childAgentId,
              child_session_key: parsedKey.key,
              reason: cached.reason,
              sessions_json_path: cached.sessionsJsonPath,
            },
            dedupe: true,
          });
          continue;
        }

        const st = String(cached.map?.[parsedKey.key]?.status || "").toLowerCase();
        if (st === "done") {
          const sid = cached.map?.[parsedKey.key]?.sessionId;
          const jsonlPath = sid ? join(cached.sessionsDir, `${sid}.jsonl`) : null;
          const parsedResultJson = jsonlPath ? parseFinalSpecialistResultJson(jsonlPath) : null;
          db.prepare(
            `UPDATE enrichment_specialist_runs
             SET status='DONE',
                 completed_at=datetime('now'),
                 result_json=COALESCE(?, result_json)
             WHERE job_id=? AND specialist_name=? AND status='PENDING'`,
          ).run(parsedResultJson, jobId, row.specialist_name);
          const changed = db.prepare(`SELECT changes() AS n`).get()?.n ?? 0;
          if (Number(changed) > 0) {
            insertEnrichmentEvent(db, {
              jobId,
              eventType: "specialist_reconciled_done",
              message: `specialist reconciled DONE via sessions_json: ${specialist}`,
              context: {
                specialist,
                child_agent_id: parsedKey.childAgentId,
                child_session_key: parsedKey.key,
                detected_via: "sessions_json",
                session_id: sid || null,
                result_json_persisted: Boolean(parsedResultJson),
              },
              dedupe: false,
            });
            n++;
          }
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
      workspacePath: string;
    }) {
      const turnSecRaw = Number.parseInt(
        process.env.ENRICH_TURN_TIMEOUT_SEC || "",
        10,
      );
      const turnSec =
        Number.isFinite(turnSecRaw) && turnSecRaw >= 60 ? turnSecRaw : 300;
      const enrichPrefix =
        String(params.messagePrefix || "ENRICH").trim() || "ENRICH";
      const payload = String(params.payloadJson || "");
      const env = agentRunEnv(params);

      const runPromise = (async () => {
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
        } finally {
          if (db0) {
            try {
              db0.close();
            } catch {}
          }
        }

        const message = `${enrichPrefix}:${payload}`;
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
        if (r?.code !== 0) {
          return {
            ok: false as const,
            error: formatAgentFailure(params.jobId, r),
          };
        }
        return { ok: true as const };
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

    function parseJsonObjectFromText(text: string) {
      const md = extractJsonFromMarkdown(text);
      if (md && typeof md === "object") return md;
      const s = String(text || "").trim();
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try {
          return JSON.parse(s.slice(first, last + 1));
        } catch {}
      }
      return null;
    }

    function collectSpecialistFindingsFromDb(db: any, jobId: string) {
      const rows = db
        .prepare(
          `SELECT specialist_name, status, result_json
           FROM enrichment_specialist_runs
           WHERE job_id=?
           ORDER BY specialist_name`,
        )
        .all(jobId);
      const findings: any[] = [];
      for (const row of rows) {
        const specialist = String(row.specialist_name || "").trim();
        if (String(row.status || "") !== "DONE") continue;
        const raw = String(row.result_json || "").trim();
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed?.findings) ? parsed.findings : [];
          for (const f of arr) {
            if (!f || typeof f !== "object") continue;
            findings.push({
              ...f,
              agent_name: String(f.agent_name || specialist),
            });
          }
        } catch {}
      }
      return findings;
    }

    async function finalizeRunningJobDeterministic(params: {
      jobId: string;
      profileId: string;
      payloadJson: string;
      workspacePath: string;
    }) {
      const env = agentRunEnv({
        jobId: params.jobId,
        profileId: params.profileId,
        workspacePath: params.workspacePath,
      });

      let db0: any | null = null;
      let findings: any[] = [];
      try {
        db0 = await openEnrichmentDb();
        findings = collectSpecialistFindingsFromDb(db0, params.jobId);
        insertEnrichmentEvent(db0, {
          jobId: params.jobId,
          eventType: "specialists_terminal",
          message: `all specialists terminal for job=${params.jobId}`,
          context: {
            profile_id: params.profileId,
            findings_count: findings.length,
          },
          dedupe: true,
        });
      } finally {
        if (db0) {
          try {
            db0.close();
          } catch {}
        }
      }

      let payload: any = {};
      try {
        payload = JSON.parse(String(params.payloadJson || "{}"));
      } catch {}
      const profileName =
        String(
          payload?.display_name ||
            `${String(payload?.first_name || "").trim()} ${String(payload?.last_name || "").trim()}`.trim() ||
            params.profileId,
        ).trim() || params.profileId;

      let scorerInput = "";
      try {
        scorerInput = JSON.stringify({
          profile_id: params.profileId,
          name: profileName,
          findings,
        });
      } catch (err: any) {
        return {
          ok: false as const,
          error: `scorer payload serialization failed: ${String(err?.message ?? err)}`,
        };
      }

      let db1: any | null = null;
      try {
        db1 = await openEnrichmentDb();
        insertEnrichmentEvent(db1, {
          jobId: params.jobId,
          eventType: "scorer_started",
          message: `starting scorer for job=${params.jobId}`,
          context: {
            profile_id: params.profileId,
            findings_count: findings.length,
          },
        });
      } finally {
        if (db1) {
          try {
            db1.close();
          } catch {}
        }
      }

      const scoreTimeoutRaw = Number.parseInt(
        process.env.ENRICH_SCORE_TIMEOUT_SEC || "",
        10,
      );
      const scoreTimeout =
        Number.isFinite(scoreTimeoutRaw) && scoreTimeoutRaw >= 30
          ? scoreTimeoutRaw
          : 180;
      const scoreRun: any = await api.runtime.system.runCommandWithTimeout(
        [
          "openclaw",
          "agent",
          "--agent",
          "enrich-scorer",
          "--message",
          `SCORE:${scorerInput}`,
          "--timeout",
          String(scoreTimeout),
        ],
        {
          timeoutMs: scoreTimeout * 1000 + 45_000,
          env,
        },
      );
      if (scoreRun?.code !== 0) {
        return {
          ok: false as const,
          error: `scorer command failed: ${formatAgentFailure(params.jobId, scoreRun)}`,
        };
      }

      const parsedScore = parseJsonObjectFromText(String(scoreRun?.stdout ?? ""));
      if (!parsedScore || typeof parsedScore !== "object") {
        let db2: any | null = null;
        try {
          db2 = await openEnrichmentDb();
          insertEnrichmentEvent(db2, {
            jobId: params.jobId,
            eventType: "scorer_failed_parse",
            message: "failed to parse scorer JSON output",
            context: {
              stdout: String(scoreRun?.stdout ?? "").slice(0, 4000),
            },
          });
        } finally {
          if (db2) {
            try {
              db2.close();
            } catch {}
          }
        }
        return {
          ok: false as const,
          error: "failed to parse scorer JSON output",
        };
      }

      const savePayload = {
        profile_id: String(parsedScore.profile_id || params.profileId),
        enrichment_score: Number(parsedScore.enrichment_score) || 0,
        score_reason: String(parsedScore.score_reason || ""),
        findings,
      };

      let db3: any | null = null;
      try {
        db3 = await openEnrichmentDb();
        insertEnrichmentEvent(db3, {
          jobId: params.jobId,
          eventType: "save_started",
          message: `starting save-enrichment for job=${params.jobId}`,
          context: {
            profile_id: params.profileId,
            enrichment_score: savePayload.enrichment_score,
            findings_count: findings.length,
          },
        });
      } finally {
        if (db3) {
          try {
            db3.close();
          } catch {}
        }
      }

      const saveRun: any = await api.runtime.system.runCommandWithTimeout(
        [
          "node",
          join(ROOT, "scripts", "save-enrichment.js"),
          JSON.stringify(savePayload),
        ],
        {
          timeoutMs: 60_000,
          env,
        },
      );
      if (saveRun?.code !== 0 || !String(saveRun?.stdout ?? "").includes("SAVED:")) {
        let db4: any | null = null;
        try {
          db4 = await openEnrichmentDb();
          insertEnrichmentEvent(db4, {
            jobId: params.jobId,
            eventType: "save_failed",
            message: "save-enrichment command failed",
            context: {
              code: saveRun?.code ?? null,
              stdout: String(saveRun?.stdout ?? "").slice(0, 4000),
              stderr: String(saveRun?.stderr ?? "").slice(0, 4000),
            },
          });
        } finally {
          if (db4) {
            try {
              db4.close();
            } catch {}
          }
        }
        return {
          ok: false as const,
          error: `save-enrichment failed (exit=${String(saveRun?.code ?? "unknown")})`,
        };
      }

      let db5: any | null = null;
      try {
        db5 = await openEnrichmentDb();
        insertEnrichmentEvent(db5, {
          jobId: params.jobId,
          eventType: "job_done",
          message: `deterministic finalize complete for profile_id=${params.profileId}`,
          context: {
            profile_id: params.profileId,
            enrichment_score: savePayload.enrichment_score,
            findings_count: findings.length,
          },
        });
      } finally {
        if (db5) {
          try {
            db5.close();
          } catch {}
        }
      }

      return { ok: true as const };
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
        cfg?.agents?.defaults?.sandbox?.browser?.enabled !== true ||
        cfg?.browser?.headless !== true ||
        cfg?.tools?.profile !== "full"
      ) {
        errors.push(
          'browser.headless, agents.defaults.sandbox.browser.allowHostControl, agents.defaults.sandbox.browser.enabled=true, and tools.profile="full" must all be set. Auto-configured on startup — if this error persists, restart the gateway once more.',
        );
      }

      return errors;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let tickInFlight: Promise<void> | null = null;
    let activeRun: null | { jobId: string; wait: () => Promise<any> } = null;
    let finalizingJobId: string | null = null;
    let dispatchCooldownUntilMs = 0;
    let lastIdleLogAt = 0;

    api.registerService({
      id: "enrichment-dispatcher",
      start: async () => {
        if (interval) return;

        let cfgForValidate: any = readFullConfig();

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
              'Configured browser prerequisites (browser.headless=true, agents.defaults.sandbox.browser.allowHostControl=true, agents.defaults.sandbox.browser.enabled=true, tools.profile="full"). Restart gateway to apply.',
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
              .prepare(
                `SELECT job_id FROM enrichment_jobs WHERE status='running'`,
              )
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
          await api.runtime.system.runCommandWithTimeout(
            ["openclaw", "--version"],
            {
              timeoutMs: 2_000,
              env: {
                ...process.env,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_CONFIG_PATH:
                  process.env.OPENCLAW_CONFIG_PATH ||
                  join(stateDir, "openclaw.json"),
              },
            },
          );
        } catch (err: any) {
          log.error(
            `OpenClaw CLI is not available for dispatch: ${String(err?.message ?? err)}`,
          );
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
                const runningJobId = String(state.row.job_id || "");
                const runningAgentId = String(
                  state.row.orchestrator_agent_id || "",
                ).trim();
                if (runningAgentId) {
                  seedSpecialistRunsFromLedger(db, {
                    jobId: runningJobId,
                    profileId: String(state.row.profile_id || ""),
                    agentId: runningAgentId,
                    startedAt: state.row.started_at,
                  });
                }
                if (runningAgentId) {
                  reconcilePendingSpecialistsFromSessions(
                    db,
                    runningJobId,
                    runningAgentId,
                  );
                }
                const counts = db
                  .prepare(
                    `SELECT
                       COUNT(*) AS total,
                       SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending
                     FROM enrichment_specialist_runs
                     WHERE job_id = ?`,
                  )
                  .get(runningJobId);
                const total = Number(counts?.total || 0);
                const pending = Number(counts?.pending || 0);
                const allTerminal = total >= 10 && pending === 0;
                if (allTerminal) {
                  if (finalizingJobId && finalizingJobId !== runningJobId) return;
                  finalizingJobId = runningJobId;
                  const workspacePath =
                    String(
                      state.row.orchestrator_workspace ||
                        process.env.ENRICHMENT_WORKSPACE ||
                        ROOT,
                    ).trim() || ROOT;
                  let finalizeResult: any = null;
                  try {
                    finalizeResult = await finalizeRunningJobDeterministic({
                      jobId: runningJobId,
                      profileId: String(state.row.profile_id || ""),
                      payloadJson: String(state.row.payload_json || ""),
                      workspacePath,
                    });
                  } finally {
                    if (finalizingJobId === runningJobId) finalizingJobId = null;
                  }
                  if (!finalizeResult.ok) {
                    await markFailed(
                      db,
                      runningJobId,
                      String(finalizeResult.error || "deterministic finalization failed").slice(
                        0,
                        1000,
                      ),
                    );
                  }
                  return;
                }
                if (state.elapsedMs > staleMs) {
                  await markFailed(
                    db,
                    runningJobId,
                    `stale timeout (${Math.round(staleMs / 60_000)} min)`,
                  );
                  if (activeRun?.jobId === runningJobId) {
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
                  row.orchestrator_agent_id ||
                    process.env.ENRICH_ORCH_AGENT_ID ||
                    "profile-enrich",
                ).trim();
                if (!agentId) {
                  await failQueuedOrRunning(
                    db,
                    jobId,
                    "missing orchestrator_agent_id",
                  );
                  return;
                }

                let cfg0 = readFullConfig();
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
                      'Configured browser prerequisites (browser.headless=true, agents.defaults.sandbox.browser.allowHostControl=true, agents.defaults.sandbox.browser.enabled=true, tools.profile="full"). Restart gateway to apply.',
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
                  row.orchestrator_workspace ||
                    process.env.ENRICHMENT_WORKSPACE ||
                    ROOT,
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
                  workspacePath: configuredWorkspace,
                });
                activeRun = { jobId, wait: run.wait };
                run
                  .wait()
                  .then(async (result) => {
                    if (result.ok) return;
                    const db2 = await openEnrichmentDb();
                    try {
                      await markFailed(
                        db2,
                        jobId,
                        String(result.error).slice(0, 1000),
                      );
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
