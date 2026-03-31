// @ts-nocheck
import fs, { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
let definePluginEntry: undefined | ((entry: any) => any);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  definePluginEntry =
    require("openclaw/plugin-sdk/plugin-entry")?.definePluginEntry;
} catch {}

const entry = {
  id: "profile-research",
  name: "upCaret Profile Research",
  description: "General-purpose profile discovery and collection",
  register(api: any) {
    const stateDir = api.runtime.state.resolveStateDir();
    const linkedRoot = fileURLToPath(new URL(".", import.meta.url));
    const installedRoot = join(stateDir, "extensions", "profile-research");
    const workspacePath = existsSync(join(linkedRoot, "agents", "researcher.md"))
      ? linkedRoot
      : installedRoot;
    const log = api.logger;

    function readFullConfig() {
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
      try {
        return JSON.parse(fs.readFileSync(configPath, "utf8") || "{}");
      } catch {
        return {};
      }
    }

    function normalizeAgentId(id: string) {
      return String(id || "").trim().toLowerCase();
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
      const allow0 = Array.isArray(cfg?.plugins?.allow) ? cfg.plugins.allow : [];
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

    async function ensureProfileResearchAgent() {
      const desiredId = "profile-researcher";
      const cfg: any = readFullConfig();
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return;
      }

      const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
      const idx = list.findIndex(
        (a: any) => normalizeAgentId(String(a?.id || "")) === desiredId,
      );

      const desiredEntry = (base: any = {}) => {
        const entry: any = {
          ...base,
          id: desiredId,
          name: base.name ?? "Profile Researcher",
          workspace: workspacePath,
          model: base.model ?? cfg?.agents?.defaults?.model,
        };
        delete entry.tools;
        return entry;
      };

      if (idx >= 0) {
        const existing = list[idx] ?? {};
        if (existing.workspace === workspacePath && !("tools" in existing)) return;
      }

      const patchedList =
        idx === -1
          ? [...list, desiredEntry()]
          : list.map((a: any, i: number) => (i === idx ? desiredEntry(a) : a));

      const patched = {
        ...cfg,
        agents: {
          ...(cfg?.agents ?? {}),
          list: patchedList,
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(
        `Configured profile-research agent "${desiredId}" (workspace=${workspacePath})`,
      );
    }

    async function ensureAcpAllowedAgents() {
      const cfg: any = readFullConfig();
      if (!cfg?.gateway?.mode) {
        log.warn(
          "OpenClaw setup not complete (gateway.mode missing). Finish setup UI, then restart gateway; plugin will self-configure.",
        );
        return;
      }
      const allow0 = Array.isArray(cfg?.acp?.allowedAgents)
        ? cfg.acp.allowedAgents
        : [];
      const required = ["profile-researcher"];
      const allow = Array.from(
        new Set([
          ...allow0.map((id: any) => String(id || "").trim()).filter(Boolean),
          ...required,
        ]),
      );
      const same =
        allow.length === allow0.length &&
        allow.every((id: any, i: number) => String(id) === String(allow0[i]));
      if (same) return;

      const patched = {
        ...cfg,
        acp: {
          ...(cfg?.acp ?? {}),
          allowedAgents: allow,
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(`Ensured acp.allowedAgents includes: ${required.join(", ")}`);
    }

    /**
     * Default workspace agents need an explicit subagents.allowAgents list or sessions_spawn to
     * other agents is forbidden. Allow spawning the research + enrichment orchestrator agents
     * (sec-iapd is skill/exec-only — no separate agent id).
     */
    const MAIN_WORKSPACE_SPAWN_TARGETS = [
      "profile-researcher",
      "profile-enrich",
    ] as const;

    async function ensureMainAgentsAllowPluginSpawns() {
      const cfg: any = readFullConfig();
      if (!cfg?.gateway?.mode) return;

      const parentIds = new Set(["main", "general"]);
      const list0: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
      const list = [...list0];
      let changed = false;

      const findIdx = (id: string) =>
        list.findIndex((a: any) => normalizeAgentId(String(a?.id || "")) === id);

      // Some deployments have legacy webchat sessions under agent:general:main. If
      // "general" isn't in agents.list, OpenClaw treats its spawn allowlist as empty.
      // To keep "install + enable" sufficient, ensure both main and general exist.
      const mainIdx = findIdx("main");
      const generalIdx = findIdx("general");
      const template = (mainIdx >= 0 ? list[mainIdx] : null) ?? {};

      const upsertMissingAlias = (id: "main" | "general") => {
        const idx = findIdx(id);
        if (idx >= 0) return;
        const entry: any = {
          id,
          name: id === "general" ? "General" : "Main",
          workspace:
            template?.workspace ??
            cfg?.agents?.defaults?.workspace ??
            "/data/.openclaw/workspace",
          model: template?.model ?? cfg?.agents?.defaults?.model,
        };
        delete entry.tools;
        list.push(entry);
        changed = true;
      };

      if (mainIdx >= 0 && generalIdx === -1) upsertMissingAlias("general");
      if (generalIdx >= 0 && mainIdx === -1) upsertMissingAlias("main");

      const patchedList = list.map((entry: any) => {
        const id = normalizeAgentId(String(entry?.id || ""));
        if (!parentIds.has(id)) return entry;

        const sub = entry?.subagents && typeof entry.subagents === "object" ? entry.subagents : {};
        const allow0 = Array.isArray(sub.allowAgents)
          ? sub.allowAgents.map((x: any) => String(x || "").trim()).filter(Boolean)
          : [];
        if (allow0.some((v: string) => v === "*")) return entry;
        const allow = Array.from(
          new Set([...allow0, ...MAIN_WORKSPACE_SPAWN_TARGETS.map(String)]),
        );
        const same =
          allow.length === allow0.length &&
          allow.every((v: string, i: number) => v === allow0[i]);
        if (same) return entry;

        changed = true;
        return {
          ...entry,
          subagents: {
            ...sub,
            allowAgents: allow,
          },
        };
      });

      if (!changed) return;

      const patched = {
        ...cfg,
        agents: {
          ...(cfg?.agents ?? {}),
          list: patchedList,
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(
        `Ensured main|general subagents.allowAgents includes: ${MAIN_WORKSPACE_SPAWN_TARGETS.join(", ")}`,
      );
    }

    void ensureProfileResearchAgent().catch((err: any) => {
      log.warn(
        `WARN — unable to auto-configure profile-researcher agent: ${String(err?.message ?? err)}`,
      );
    });

    void ensureTrustedPluginsAllow().catch((err: any) => {
      log.warn(`WARN — unable to pin plugins.allow: ${String(err?.message ?? err)}`);
    });

    void ensureAcpAllowedAgents().catch((err: any) => {
      log.warn(
        `WARN — unable to auto-configure acp.allowedAgents: ${String(err?.message ?? err)}`,
      );
    });

    void ensureMainAgentsAllowPluginSpawns().catch((err: any) => {
      log.warn(
        `WARN — unable to set subagents.allowAgents for main|general: ${String(err?.message ?? err)}`,
      );
    });

  },
};

export default typeof definePluginEntry === "function"
  ? definePluginEntry(entry)
  : entry;
