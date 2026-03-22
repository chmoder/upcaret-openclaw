# Distribution and install (release checklist)

## Minimum OpenClaw version

**OpenClaw >= 2026.3.x is required.** PR #29515 (merged March 16 2026) fixed a bug that silently cleared plugin-registered `gateway:startup` hooks on every restart. Earlier versions will install the plugin but the PM2 auto-start hook will never fire.

---

## Install story (one sentence)

**`openclaw plugins install advisor-lead-gen`**, set your `BRAVE_API_KEY`, restart the gateway — cron starts automatically on every boot from that point on.

---

## What "ready to distribute" means

| Requirement | Why |
|---|---|
| `package.json`.`version` and `openclaw.plugin.json`.`version` match what you advertise | Installers and support can correlate bugs to a release. |
| `npm test` passes in the plugin root | Required scripts and agents are all present. |
| No `advisors.db`, `node_modules`, `.env`, or secrets in the artifact | Recipients run bootstrap via the plugin hook and supply their own keys. |
| `openclaw.plugin.json` and `SKILL.md` sit directly in `advisor-lead-gen/` — not nested deeper | Matches the plugin layout expected by OpenClaw. |

---

## Packaging (maintainer)

```bash
cd plugins/advisor-lead-gen
npm test
# bump version in both package.json and openclaw.plugin.json if needed
```

**Exclude** from archives: `node_modules/`, `advisors.db`, `.env`, `*.log`, `.DS_Store`.

**Include** everything else: `scripts/`, `agents/`, `references/`, `SKILL.md`, `IDENTITY.md`, `package.json`, `package-lock.json`, `openclaw.plugin.json`, `plugin-entry.ts`, `ecosystem.config.js`, `ARCHITECTURE.md`, `README.md`.

Suggested archive name: `sec-iapd-advisor-enrichment-<version>.zip`

---

## Recipient install

### Option A: ClawHub (when published)

```bash
openclaw plugins install advisor-lead-gen
openclaw plugins enable advisor-lead-gen
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

### Option B: Local dev / zip handoff

```bash
# Link in place (dev — changes in repo are live immediately):
openclaw plugins install -l /path/to/advisor-lead-gen

# Or extract a zip:
mkdir -p ~/.openclaw/extensions/advisor-lead-gen
unzip sec-iapd-advisor-enrichment-<version>.zip \
  -d ~/.openclaw/extensions/advisor-lead-gen

# Then continue:
openclaw plugins enable advisor-lead-gen
openclaw config set env.BRAVE_API_KEY "<key>"
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/extensions/advisor-lead-gen
openclaw gateway restart
```

### Option C: From OpenClaw chat

Say **"set up the lead gen skill"**. The main agent reads `SKILL.md` (discovered via the plugin manifest) and follows **`references/SETUP_WIZARD.md`** — it will prompt for `BRAVE_API_KEY` and run the remaining manual steps.

### One-time prerequisite: PM2

PM2 must be installed globally before the first gateway restart. The plugin will log a clear error if it is missing:

```bash
npm install -g pm2
openclaw gateway restart
```

After that — every restart is automatic. No further manual steps.

---

## Related

- `references/SETUP_WIZARD.md` — chat-first setup (same end state as manual install above)
- `references/INSTALL_AUTOMATION.md` — full detail on what the plugin automates and what requires the OpenClaw CLI
