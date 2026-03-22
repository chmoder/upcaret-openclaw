# UpCaret OpenClaw

This repository holds OpenClaw **plugins** and related docs for UpCaret. The main product is **`plugins/advisor-lead-gen`**: a native OpenClaw plugin (with bundled `SKILL.md`) for SEC IAPD advisor lead gen and enrichment.

## Layout

```text
plugins/
  advisor-lead-gen/     # SEC IAPD download + orchestrated enrichment (plugin + skill)
```

Each plugin folder is self-contained: `openclaw.plugin.json`, `plugin-entry.ts`, `SKILL.md`, `package.json`, `scripts/`, `agents/`, `references/`, etc.

## Install (OpenClaw)

Use the plugin flow (see **`plugins/advisor-lead-gen/references/DISTRIBUTION.md`**):

```bash
openclaw plugins install advisor-lead-gen   # or: openclaw plugins install -l /path/to/plugins/advisor-lead-gen
openclaw plugins enable advisor-lead-gen
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw agents add advisor-enrich --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

In chat you can still say **“set up the lead gen skill”** — the agent follows **`plugins/advisor-lead-gen/references/SETUP_WIZARD.md`**.

## Prerequisites

- **Node.js** 22.5+ (required by `node:sqlite`; see each plugin’s `package.json` `engines`)
- **sqlite3** CLI on `PATH` (used by bootstrap / DB scripts)
- For enrichment: **`BRAVE_API_KEY`** (and optional keys per plugin docs)

## Working on the plugin

```bash
cd plugins/advisor-lead-gen
npm install   # only if you add dependencies; currently empty
npm test
npm run bootstrap
```

## Publishing

- **npm / OpenClaw:** plugin `package.json` includes `openclaw.extensions`; see OpenClaw docs for `openclaw plugins install <npm-spec>`.
- **ClawHub / private B2B:** distribute a zip or grant access to this repo — exclude `advisors.db`, `node_modules`, secrets.

## License

Per-plugin licenses are declared in each `package.json` (default MIT unless noted otherwise).
