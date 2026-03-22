# sec-iapd-advisor-enrichment (OpenClaw plugin)

- **Download advisors:** `scripts/extract-advisors.js` → `advisors.db`
- **Enrich (OpenClaw agent-to-agent):** `IDENTITY.md` (orchestrator system prompt) + `agents/*.md`

## Install (OpenClaw plugin)

1. **`openclaw plugins install advisor-lead-gen`** (or **`openclaw plugins install -l /path/to/plugins/advisor-lead-gen`** from this repo).
2. **`openclaw plugins enable advisor-lead-gen`**, set **`BRAVE_API_KEY`**, add **`advisor-enrich`** with **`--workspace ~/.openclaw/extensions/advisor-lead-gen`**, **`openclaw gateway restart`**.
3. In chat: **"set up the lead gen skill"** — the agent follows **`references/SETUP_WIZARD.md`**.

See **`SKILL.md`**, **`references/DISTRIBUTION.md`**, and **`references/INSTALL_AUTOMATION.md`**.

```bash
npm run bootstrap      # idempotent: checks + db:init (run anytime)
npm run setup:openclaw # print OpenClaw CLI steps (+ plugins install/enable if CLI exists)
npm run extract -- --help
npm run env:help
```

**Chat / main agent:** follow **`references/ASSISTANT_GUIDE.md`**.

Enrichment is driven from OpenClaw via `sessions_send` with `ENRICH:{...}` (see `SKILL.md`).
