# OpenClaw plugins

Each subdirectory is an installable OpenClaw plugin (ships `openclaw.plugin.json` + `plugin-entry.ts` where applicable).

| Plugin                | Description                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **enrichment-engine** | Generic job queue dispatcher — poll loop, agent spawn, stale recovery. Required by domain plugins.                                |
| **advisor-lead-gen**  | SEC IAPD advisor domain layer — data download, orchestrator skill, specialist agents, lead scoring. Requires `enrichment-engine`. |

## Install order

`enrichment-engine` must be installed and enabled before any domain plugin that depends on it:

```bash
# If published in your marketplace/registry:
openclaw plugins install enrichment-engine
openclaw plugins install advisor-lead-gen

# If `enrichment-engine` is not published yet, install from an artifact/path instead:
#   openclaw plugins install /path/to/enrichment-engine
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
openclaw gateway restart
```

After a new release:

```bash
openclaw plugins update enrichment-engine
openclaw plugins update advisor-lead-gen
openclaw gateway restart
```

Install and upgrades are only through the OpenClaw CLI (ClawHub / npm / published artifact), not paths into this repo.
