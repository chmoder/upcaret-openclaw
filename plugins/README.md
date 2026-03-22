# OpenClaw plugins

Each subdirectory is an installable OpenClaw plugin (ships `openclaw.plugin.json` + `plugin-entry.ts` where applicable).

| Plugin | Description |
|--------|-------------|
| **advisor-lead-gen** | SEC IAPD advisor download + multi-agent enrichment (`SKILL.md` bundled via manifest) |

Install and upgrades are only through the OpenClaw CLI (ClawHub / npm / published artifact), not paths into this repo:

```bash
openclaw plugins install advisor-lead-gen
openclaw plugins enable advisor-lead-gen
# after a new release:
openclaw plugins update advisor-lead-gen && openclaw gateway restart
```
