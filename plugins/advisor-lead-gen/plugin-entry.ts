// @ts-nocheck
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
  definePluginEntry =
    require("openclaw/plugin-sdk/plugin-entry")?.definePluginEntry;
} catch {}

const entry = {
  id: "advisor-lead-gen",
  name: "SEC IAPD Advisor Lead Gen",
  description: "Advisor domain plugin (SEC IAPD data + orchestration assets)",
  register(api: any) {
    const ROOT = join(
      api.runtime.state.resolveStateDir(),
      "extensions",
      "advisor-lead-gen",
    );
    const log = api.logger;
    const ORCH_AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";

    function normalizeAgentId(id: string) {
      return (id || "").trim().toLowerCase();
    }

    async function initDomainDb() {
      const { openDb } = await import(
        pathToFileURL(join(ROOT, "scripts/db.js")).href
      );
      const { initSchema } = await import(
        pathToFileURL(join(ROOT, "scripts/db-init.js")).href
      );
      const db = openDb();
      initSchema(db);
      db.close();
    }

    async function ensureAdvisorPipelineRow() {
      const {
        openEngineDb,
        resolveEngineDbPath,
        initEngineSchema,
        ensureAdvisorPipeline,
      } = await import(pathToFileURL(join(ROOT, "scripts/engine-db.js")).href);
      const engineDb = openEngineDb(resolveEngineDbPath());
      try {
        initEngineSchema(engineDb);
        ensureAdvisorPipeline(engineDb);
      } finally {
        engineDb.close();
      }
    }

    async function ensureAdvisorEnrichAgentConfig(cfg: any) {
      const wanted = normalizeAgentId(ORCH_AGENT_ID);
      const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
      const exists = list.some(
        (a: any) => normalizeAgentId(String(a?.id || "")) === wanted,
      );
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
              id: ORCH_AGENT_ID,
              name: "Advisor Enrich",
              workspace: ROOT,
              model: cfg?.agents?.defaults?.model,
            },
          ],
        },
      };
      try {
        await api.runtime.config.writeConfigFile(patched);
        log.info(`Configured agent "${ORCH_AGENT_ID}" workspace=${ROOT}`);
      } catch (err: any) {
        log.warn(
          `WARN — unable to persist agent config: ${String(err?.message ?? err)}`,
        );
      }
      return patched;
    }

    function validateSetup(cfg: any): string[] {
      const errors: string[] = [];
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 5)) {
        errors.push(
          `Node ${process.versions.node} is too old — requires 22.5+. Upgrade: https://nodejs.org`,
        );
      }

      for (const rel of [
        "IDENTITY.md",
        "scripts/db.js",
        "scripts/db-init.js",
        "scripts/engine-db.js",
      ]) {
        if (!existsSync(join(ROOT, rel))) {
          errors.push(`Missing ${rel} — reinstall the plugin.`);
        }
      }

      const braveKey = String(
        process.env.BRAVE_API_KEY || cfg?.env?.BRAVE_API_KEY || "",
      ).trim();
      if (!braveKey) {
        errors.push(
          "BRAVE_API_KEY missing. Add it under OpenClaw Settings → Environment variables (stored as config `env.BRAVE_API_KEY`), or run: openclaw config set env.BRAVE_API_KEY \"<key>\"",
        );
      }

      const maxChildren = Number(
        cfg?.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5,
      );
      if (!Number.isFinite(maxChildren) || maxChildren < 10) {
        errors.push(
          "agents.defaults.subagents.maxChildrenPerAgent must be >= 10 for advisor enrichment (10 specialists). Fix: openclaw config set agents.defaults.subagents.maxChildrenPerAgent 12 && openclaw gateway restart",
        );
      }

      return errors;
    }

    api.registerService({
      id: "advisor-lead-gen-initializer",
      start: async () => {
        let cfgForValidate: any = {};
        try {
          cfgForValidate = api.runtime.config.loadConfig() ?? {};
        } catch {
          cfgForValidate = {};
        }
        const errors = validateSetup(cfgForValidate);
        if (errors.length > 0) {
          log.error("SETUP ERRORS — fix these and restart the gateway:");
          errors.forEach((e, i) => log.error(`  ${i + 1}. ${e}`));
          log.error(`Setup guide: ${join(ROOT, "references/SETUP_WIZARD.md")}`);
          return;
        }

        // Ensure domain DB schema exists up-front.
        try {
          await initDomainDb();
        } catch (err: any) {
          log.error(
            `DB init failed: ${String(err?.message ?? err)} — run: cd ${ROOT} && npm run bootstrap`,
          );
          return;
        }

        // Ensure advisors pipeline row exists in engine DB before any enqueue.
        try {
          await ensureAdvisorPipelineRow();
        } catch (err: any) {
          log.error(
            `Pipeline init failed: ${String(err?.message ?? err)} — run: cd ${ROOT} && npm run bootstrap`,
          );
          return;
        }

        // Fail fast if the gateway cannot spawn the OpenClaw CLI.
        try {
          const stateDir = api.runtime.state.resolveStateDir();
          const configPath =
            process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
          await api.runtime.system.runCommandWithTimeout(
            ["openclaw", "--version"],
            {
              timeoutMs: 2_000,
              env: {
                ...process.env,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_CONFIG_PATH: configPath,
              },
            },
          );
        } catch (err: any) {
          log.error(
            `OpenClaw CLI is not available for dispatch: ${String(err?.message ?? err)}`,
          );
          return;
        }

        // Ensure orchestrator agent exists (fresh load — never persist from empty cfg).
        try {
          const cfg0 = api.runtime.config.loadConfig();
          await ensureAdvisorEnrichAgentConfig(cfg0);
        } catch (err: any) {
          log.error(
            `Cannot ensure agent "${ORCH_AGENT_ID}": ${String(err?.message ?? err)}`,
          );
          return;
        }



        log.info(
          `advisor-lead-gen initialized (agent=${ORCH_AGENT_ID}). Queue dispatch is owned by enrichment-engine.`,
        );
      },
      stop: async () => {},
    });
  },
};

export default typeof definePluginEntry === "function"
  ? definePluginEntry(entry)
  : entry;
