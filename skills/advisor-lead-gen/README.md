# sec-iapd-advisor-enrichment

- **Download advisors:** `scripts/extract-advisors.js` → `advisors.db`
- **Enrich (OpenClaw agent-to-agent):** `IDENTITY.md` (orchestrator system prompt) + `agents/*.md`

## Use in any OpenClaw

1. Copy the **contents** of this folder into **`~/.openclaw/workspace/skills/advisor-lead-gen`** (so **`package.json`** is at that path's root).
2. In chat: **"set up the lead gen skill"** — the agent follows **`references/SETUP_WIZARD.md`** (runs **`bootstrap` / `setup:openclaw`** via exec when available; you don't need Terminal first).
3. Without chat: **`cd ~/.openclaw/workspace/skills/advisor-lead-gen`** then **`npm run bootstrap`** and **`npm run setup:openclaw`** on the gateway host.

See **`SKILL.md`** for setup, **`references/SETUP_WIZARD.md`** for the guided install phrase, **`ARCHITECTURE.md`** for the layout, and **`references/OPENCLAW_RUNTIME.md`** for Session Tools (`sessions_send`, `sessions_spawn`, etc.).

```bash
npm run bootstrap      # idempotent: checks + db:init (run anytime)
npm run setup:openclaw # print OpenClaw CLI steps (+ agents list if CLI exists)
npm run extract -- --help
npm run env:help
```

See **`references/INSTALL_AUTOMATION.md`** for limits of skill-side automation.  
**Chat / main agent:** follow **`references/ASSISTANT_GUIDE.md`** (OpenClaw actions first, then tell the user what's left).

Enrichment is driven from OpenClaw via `sessions_send` with `ENRICH:{...}` (see `SKILL.md`).
