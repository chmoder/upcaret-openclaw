# upCaret OpenClaw

This repository holds OpenClaw **plugins** and related docs for upCaret. The current stack includes:

- **`plugins/enrichment`**: standalone person enrichment core (unified DB + dispatcher + orchestrator/specialists).
- **`plugins/sec-iapd`**: optional SEC IAPD source adapter that imports profiles into `enrichment`.

## Layout

```text
plugins/
  enrichment/           # standalone enrichment core plugin
  sec-iapd/             # SEC IAPD importer adapter plugin
```

Each plugin folder is self-contained: `openclaw.plugin.json`, `plugin-entry.ts`, `SKILL.md`, `package.json`, `scripts/`, `agents/`, `references/`, etc.

## Install (OpenClaw)

Installs go through OpenClaw only: the CLI pulls the plugin into OpenClaw's managed extensions directory.

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw plugins install sec-iapd
openclaw plugins enable sec-iapd
openclaw gateway restart
```

Seed SEC profiles (optional adapter):

```bash
cd ~/.openclaw/extensions/sec-iapd
npm run import -- --state <STATE> --limit <N> --quiet
```

## Prerequisites

- **Node.js** 22.5+ (required by `node:sqlite`)
- Provider/API keys required by your enrichment runtime setup (for example web search tooling)

## Release workflow (maintainers)

Every change ships as a new version: bump `package.json` and `openclaw.plugin.json`, run tests, publish, then operators run `openclaw plugins update`.

```bash
cd plugins/enrichment
npm install   # only if you add dependencies; currently empty
npm run db:init
```

## License

Per-plugin licenses are declared in each `package.json` (default MIT unless noted otherwise).
