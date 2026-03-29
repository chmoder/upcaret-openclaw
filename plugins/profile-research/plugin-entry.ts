import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-nocheck
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

    function normalizeAgentId(id: string) {
      return String(id || "").trim().toLowerCase();
    }

    async function ensureTrustedPluginsAllow() {
      const trusted = ["enrichment", "profile-research", "sec-iapd"];
      let cfg: any = {};
      try {
        cfg = api.runtime.config.loadConfig() ?? {};
      } catch {
        cfg = {};
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
          name: base.name ?? "Profile Researcher",
          workspace: workspacePath,
          model: base.model ?? cfg?.agents?.defaults?.model,
        };
        // Avoid per-agent allowlists that could block required tools.
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

    async function ensureSubagentAllow() {
      const toAllow = ["profile-researcher", "profile-enrich"];
      let cfg: any = {};
      try {
        cfg = api.runtime.config.loadConfig() ?? {};
      } catch {
        cfg = {};
      }
      const current = cfg?.agents?.defaults?.subagents?.allow;
      const current0: string[] = Array.isArray(current) ? current.map(String) : [];
      const merged = Array.from(new Set([...current0, ...toAllow]));
      if (merged.length === current0.length && merged.every((id, i) => id === current0[i])) return;

      const patched = {
        ...cfg,
        agents: {
          ...(cfg?.agents ?? {}),
          defaults: {
            ...(cfg?.agents?.defaults ?? {}),
            subagents: {
              ...(cfg?.agents?.defaults?.subagents ?? {}),
              allow: merged,
            },
          },
        },
      };
      await api.runtime.config.writeConfigFile(patched);
      log.info(`Pinned agents.defaults.subagents.allow: ${merged.join(", ")}`);
    }

    void ensureProfileResearchAgent().catch((err: any) => {
      log.warn(
        `WARN — unable to auto-configure profile-researcher agent: ${String(err?.message ?? err)}`,
      );
    });

    void ensureTrustedPluginsAllow().catch((err: any) => {
      log.warn(`WARN — unable to pin plugins.allow: ${String(err?.message ?? err)}`);
    });

    void ensureSubagentAllow().catch((err: any) => {
      log.warn(`WARN — unable to pin subagents.allow: ${String(err?.message ?? err)}`);
    });
  },
};

export default typeof definePluginEntry === "function"
  ? definePluginEntry(entry)
  : entry;
