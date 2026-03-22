# Distribution and install (release checklist)

## Install story (one sentence)

**Copy the skill to `~/.openclaw/workspace/skills/advisor-lead-gen/`, then say "set up the lead gen skill" in OpenClaw chat.**

That is the entire install requirement. The main agent discovers the skill there, runs bootstrap, registers the `advisor-enrich` agent pointing at that same directory, and collects API keys — no second copy, no separate orchestrator directory.

---

## What "ready to distribute" means

| Requirement | Why |
|---|---|
| `package.json`.`version` matches what you advertise | Installers and support can correlate bugs to a release. |
| `npm test` passes in the skill root | Required scripts and agents are all present. |
| No `advisors.db`, `node_modules`, `.env`, or secrets in the artifact | Recipients run `npm run bootstrap` and supply their own keys. |
| Extracted/copied so `package.json` and `SKILL.md` sit directly in `advisor-lead-gen/` — not nested deeper | Matches the flat workspace layout. |

---

## Packaging (maintainer)

```bash
cd skills/advisor-lead-gen
npm test
# bump version in package.json if needed
```

**Exclude** from archives: `node_modules/`, `advisors.db`, `.env`, `*.log`, `.DS_Store`.

**Include** everything else: `scripts/`, `agents/`, `references/`, `SKILL.md`, `package.json`, `package-lock.json`, `ARCHITECTURE.md`, `README.md`.

Suggested archive name: `sec-iapd-advisor-enrichment-<version>.zip`

---

## Recipient install

### Option A: zip handoff

```bash
mkdir -p ~/.openclaw/workspace/skills/advisor-lead-gen
# Extract flat so package.json is at the root (not nested under advisor-lead-gen/advisor-lead-gen/):
unzip sec-iapd-advisor-enrichment-<version>.zip -d ~/.openclaw/workspace/skills/advisor-lead-gen
```

### Option B: from this git repo

```bash
rsync -a --exclude node_modules --exclude advisors.db \
  /path/to/upcaret-openclaw-skills/skills/advisor-lead-gen/ \
  ~/.openclaw/workspace/skills/advisor-lead-gen/
```

### Then — from OpenClaw chat

Say **"set up the lead gen skill"**. The agent handles the rest via `references/SETUP_WIZARD.md`.

### Or — fully manual (no chat)

```bash
cd ~/.openclaw/workspace/skills/advisor-lead-gen
npm run bootstrap
npm run setup:openclaw
# Run the printed openclaw agents add and config set commands
```

---

## Related

- `references/SETUP_WIZARD.md` — chat-first setup (same end state as manual install above)
- `references/INSTALL_AUTOMATION.md` — what requires the OpenClaw CLI / gateway
