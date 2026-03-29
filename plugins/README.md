# OpenClaw plugins

Each subdirectory is an installable OpenClaw plugin (ships `openclaw.plugin.json` + `plugin-entry.ts` where applicable).

| Plugin | Description |
| --- | --- |
| **enrichment** | Standalone person-enrichment core: unified DB, queue dispatcher, orchestrator, specialists, scoring. |
| **sec-iapd** | Optional SEC IAPD source adapter plugin that imports profiles into `enrichment`. |
| **profile-research** | General-purpose profile discovery plugin that collects one or many profiles from web research. |

## Install order

`enrichment` is standalone. `sec-iapd` and `profile-research` are optional and depend on `enrichment`.

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw plugins install sec-iapd
openclaw plugins enable sec-iapd
openclaw plugins install profile-research
openclaw plugins enable profile-research
openclaw gateway restart
```

After a new release:

```bash
openclaw plugins update enrichment
openclaw plugins update sec-iapd
openclaw plugins update profile-research
openclaw gateway restart
```
