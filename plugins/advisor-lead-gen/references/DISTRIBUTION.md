# Distribution and install (release checklist)

## Minimum OpenClaw version

**OpenClaw >= 2026.3.x is required.** The PM2-less design depends on plugin services and runtime command execution APIs (`api.registerService` + `api.runtime.system.runCommandWithTimeout`).

---

## Install story (one sentence)

Install and enable both plugins (`enrichment-engine` + `advisor-lead-gen`), set **`BRAVE_API_KEY`** in OpenClaw config (UI **Settings → Environment variables** or `openclaw config set env.BRAVE_API_KEY`), optionally **`FIRECRAWL_API_KEY`** if your gateway uses Firecrawl for `web_fetch`, restart gateway — engine dispatch starts automatically.

## Upgrades (every new release)

After you publish a new version (ClawHub and/or npm), operators pull it with the same toolchain — no repo paths:

```bash
openclaw plugins update enrichment-engine
openclaw plugins update advisor-lead-gen
openclaw gateway restart
```

Use `openclaw plugins update --all` if you prefer to refresh every tracked plugin. Npm-based installs can also use `openclaw plugins install advisor-lead-gen@<version>` to pin or move versions.

---

## What "ready to distribute" means

| Requirement                                                                                   | Why                                                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `package.json`.`version` and `openclaw.plugin.json`.`version` match what you advertise        | Installers and support can correlate bugs to a release.                 |
| `npm test` passes in the plugin root                                                          | Required scripts and agents are all present.                            |
| No `advisors.db`, `node_modules`, `.env`, or secrets in the artifact                          | Recipients run bootstrap via the plugin hook and supply their own keys. |
| `openclaw.plugin.json` and `SKILL.md` sit directly in `advisor-lead-gen/` — not nested deeper | Matches the plugin layout expected by OpenClaw.                         |

---

## Packaging (maintainer)

```bash
cd plugins/advisor-lead-gen
npm test
# bump version in both package.json and openclaw.plugin.json if needed
```

**Exclude** from archives: `node_modules/`, `advisors.db`, `.env`, `*.log`, `.DS_Store`.

**Include** everything else: `scripts/`, `agents/`, `references/`, `SKILL.md`, `IDENTITY.md`, `package.json`, `package-lock.json`, `openclaw.plugin.json`, `plugin-entry.ts`, `ARCHITECTURE.md`, `README.md`.

Suggested archive name: `advisor-lead-gen-<version>.zip`

---

## Recipient install

### Option A: ClawHub (when published)

```bash
openclaw plugins install enrichment-engine
openclaw plugins install advisor-lead-gen
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

If `openclaw plugins install enrichment-engine` fails with “Package not found on npm”, install it from the same marketplace you used for `advisor-lead-gen` (if published there), or from an artifact/path:

```bash
openclaw plugins install /path/to/enrichment-engine
openclaw plugins enable enrichment-engine
openclaw gateway restart
```

### Option B: Offline zip (air-gapped / handoff)

Extract the release archive into OpenClaw’s extensions tree, then enable and finish setup (same as Option A after files are on disk):

```bash
mkdir -p ~/.openclaw/extensions/advisor-lead-gen
unzip advisor-lead-gen-<version>.zip \
  -d ~/.openclaw/extensions/advisor-lead-gen

openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

Treat zip updates like any other release: replace the directory contents with a new build, then **`openclaw gateway restart`** (and use **`openclaw plugins update`** when the install is tracked as npm/marketplace).

### Option C: From OpenClaw chat

Say **"set up the lead gen skill"**. The main agent reads `SKILL.md` (discovered via the plugin manifest) and follows **`references/SETUP_WIZARD.md`** — it will prompt for `BRAVE_API_KEY` and run the remaining manual steps.

After setup, queue dispatch is handled by the plugin inside the gateway process. No PM2 install is required.

---

---

## Shared engine database path

Both plugins must read and write the **same** `enrichment.db` file. By default each plugin resolves the path independently using the same logic:

```
$ENRICHMENT_ENGINE_DB_PATH   (if set — takes priority)
$OPENCLAW_HOME/enrichment/enrichment.db
~/.openclaw/enrichment/enrichment.db
```

If your gateway uses a non-standard state directory (e.g. custom `OPENCLAW_HOME`), set `ENRICHMENT_ENGINE_DB_PATH` explicitly in the gateway environment so both plugins resolve to the same file:

```bash
export ENRICHMENT_ENGINE_DB_PATH=/data/openclaw/enrichment/enrichment.db
openclaw gateway restart
```

A silent path mismatch creates two separate databases: the engine dispatcher writes to one and the advisor scripts read/write to another, causing jobs to never be picked up.

---

## Related

- `references/SETUP_WIZARD.md` — chat-first setup (same end state as manual install above)
- `references/INSTALL_AUTOMATION.md` — full detail on what the plugin automates and what requires the OpenClaw CLI
