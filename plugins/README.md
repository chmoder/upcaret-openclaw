# OpenClaw plugins

Each subdirectory is an installable OpenClaw plugin (ships `openclaw.plugin.json` + `plugin-entry.ts` where applicable).

| Plugin | Description |
|--------|-------------|
| **advisor-lead-gen** | SEC IAPD advisor download + multi-agent enrichment (`SKILL.md` bundled via manifest) |

Local dev install:

```bash
openclaw plugins install -l /absolute/path/to/upcaret-openclaw/plugins/advisor-lead-gen
openclaw plugins enable advisor-lead-gen
```
