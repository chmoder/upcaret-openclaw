# UpCaret OpenClaw

This repository holds OpenClaw **plugins** and related docs for UpCaret. The current stack includes:

- **`plugins/enrichment-engine`**: generic enrichment dispatcher/queue engine.
- **`plugins/advisor-lead-gen`**: SEC IAPD advisor domain plugin and orchestrator assets.

## Layout

```text
plugins/
  enrichment-engine/    # generic dispatcher + enrichment.db job history
  advisor-lead-gen/     # SEC IAPD download + orchestrated enrichment (plugin + skill)
```

Each plugin folder is self-contained: `openclaw.plugin.json`, `plugin-entry.ts`, `SKILL.md`, `package.json`, `scripts/`, `agents/`, `references/`, etc.

## Install (OpenClaw)

Installs go through OpenClaw only: the CLI pulls the plugin into **OpenClaw’s managed extensions directory** (not a path in this git repo). See **`plugins/advisor-lead-gen/references/DISTRIBUTION.md`**.

```bash
openclaw plugins install enrichment-engine
openclaw plugins install advisor-lead-gen
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
# BRAVE_API_KEY: OpenClaw Settings → Environment variables, or:
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw agents add advisor-enrich --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

Notes:

- If `openclaw plugins install enrichment-engine` fails with “Package not found on npm”, it is not published to your current marketplace. Install it from an artifact/path instead (see `plugins/enrichment-engine/README.md` and `plugins/advisor-lead-gen/references/DISTRIBUTION.md`).

Rebuild advisor domain DB for the standardized schema:

```bash
rm -f ~/.openclaw/extensions/advisor-lead-gen/advisors.db
cd ~/.openclaw/extensions/advisor-lead-gen
npm run bootstrap
npm run extract -- --state <STATE> --limit <N>
```

**After you publish a new version**: update both plugins (or `--all`), then restart gateway.

In chat you can still say **“set up the lead gen skill”** — the agent follows **`plugins/advisor-lead-gen/references/SETUP_WIZARD.md`**.

## Prerequisites

- **Node.js** 22.5+ (required by `node:sqlite`; see each plugin’s `package.json` `engines`)
- For enrichment: **`BRAVE_API_KEY`** in OpenClaw config / Settings (optional keys per plugin docs)

## Release workflow (maintainers)

Every change ships as a new version: bump `package.json` and `openclaw.plugin.json`, run tests, publish to **ClawHub and/or npm** (`advisor-lead-gen`), then operators run **`openclaw plugins update`**.

```bash
cd plugins/advisor-lead-gen
npm install   # only if you add dependencies; currently empty
npm test
npm run bootstrap
```

See **`plugins/advisor-lead-gen/references/DISTRIBUTION.md`** for packaging, artifacts, and offline zip installs.

## License

Per-plugin licenses are declared in each `package.json` (default MIT unless noted otherwise).
