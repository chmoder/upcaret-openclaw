# sec-iapd-advisor-enrichment

- **Download advisors:** `scripts/extract-advisors.js` → `advisors.db`
- **Enrich (OpenClaw agent-to-agent):** `scripts/orchestrator.js` + `agents/*.md`

See **`SKILL.md`** for setup, **`ARCHITECTURE.md`** for the layout, and **`references/OPENCLAW_RUNTIME.md`** for how this skill fits OpenClaw Session Tools (`sessions_send`, `sessions_spawn`, etc.).

```bash
npm run bootstrap      # idempotent: checks + db:init (run anytime)
npm run setup:openclaw # print OpenClaw CLI steps (+ agents list if CLI exists)
npm run extract -- --help
npm run env:help
```

See **`references/INSTALL_AUTOMATION.md`** for limits of skill-side automation.  
**Chat / main agent:** follow **`references/ASSISTANT_GUIDE.md`** (OpenClaw actions first, then tell the user what’s left).

Enrichment is driven from OpenClaw via `sessions_send` with `ENRICH:{...}` (see `SKILL.md`).
