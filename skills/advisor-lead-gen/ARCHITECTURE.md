# Architecture

This package contains **only**:

1. **SEC download** — `scripts/extract-advisors.js` (HTTP API → `advisors.db`)
2. **OpenClaw enrichment** — `scripts/orchestrator.js` + specialist prompts in `agents/*.md` (`sessions_spawn` / `sessions_yield` / merge / DB)

Everything else was removed.

| Path | Role |
|------|------|
| `scripts/extract-advisors.js` | Download/sync advisors from SEC IAPD |
| `scripts/orchestrator.js` | `ENRICH:{json}` handling, specialist spawns, scoring |
| `agents/*.md` | Prompts for profile, email, … network, scorer |
| `scripts/db-init.js` | SQLite schema |
| `scripts/bootstrap.js` | **Idempotent** checks + `db:init` (`npm run bootstrap`) |
| `scripts/env.js`, `scripts/env-help.js` | Env specs + `npm run env:help` |
| `references/MAIN_AGENT_ROUTING.md` | Main agent → `sessions_send` / `ENRICH` routing notes |
| `references/OPENCLAW_RUNTIME.md` | **OpenClaw** session tools, persistent agent, send/poll behavior |
| `references/INSTALL_AUTOMATION.md` | What the skill can automate vs gateway/CLI-only steps |
| `references/ASSISTANT_GUIDE.md` | **Chat agents:** try Session Tools first; if blocked, tell user operator steps |
| `scripts/openclaw-setup.js` | `npm run setup:openclaw` — print steps, optional `--apply-env` |
