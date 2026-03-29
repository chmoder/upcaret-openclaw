# OpenClaw plugins

Each subdirectory is an installable OpenClaw plugin (ships `openclaw.plugin.json` + `plugin-entry.ts` where applicable).

| Plugin | Description |
| --- | --- |
| **enrichment** | Standalone person-enrichment core: unified DB, queue dispatcher, orchestrator, specialists, scoring. |
| **sec-iapd** | Optional SEC IAPD source adapter plugin that imports profiles into `enrichment`. |

## Install order

`enrichment` is standalone. `sec-iapd` is optional and depends on `enrichment`.

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw plugins install sec-iapd
openclaw plugins enable sec-iapd
openclaw gateway restart
```

After a new release:

```bash
openclaw plugins update enrichment
openclaw plugins update sec-iapd
openclaw gateway restart
```
