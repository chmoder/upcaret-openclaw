# Architecture

This package owns the **advisor domain**:

1. **SEC download** — `scripts/extract-advisors.js` (HTTP API → `advisors.db`)
2. **OpenClaw enrichment** — `IDENTITY.md` (system prompt for the `advisor-enrich` agent) + specialist prompts in `agents/*.md`
3. **Engine integration** — `scripts/engine-db.js` + helpers that write jobs/events into `enrichment.db`

Queue dispatch is owned by the companion plugin `enrichment-engine` (it polls `enrichment.db` and runs the orchestrator).

| Path                                    | Role                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `scripts/extract-advisors.js`           | Download/sync advisors from SEC IAPD                                                                     |
| `IDENTITY.md`                           | System prompt for the `advisor-enrich` agent — pure orchestrator persona, refuses off-topic messages     |
| `scripts/enqueue-enrich.js`             | Write one `enrichment_jobs` row in `enrichment.db` for a specific advisor (`--sec-id`)                   |
| `scripts/next-advisor.js`               | Find the next advisor due for enrichment (never enriched → hash changed → stale)                        |
| `scripts/record-enrichment.js`          | All queue/specialist/error state writes (`queue-start`, `specialist-done`, `log-error`, etc.)            |
| `scripts/save-enrichment.js`            | Write findings + score to `advisors.db` and mark queue row `done` via `node:sqlite`                     |
| `agents/*.md`                           | Prompts for profile, email, … network, scorer                                                            |
| `scripts/db-init.js`                    | SQLite schema                                                                                            |
| `scripts/bootstrap.js`                  | **Idempotent** checks + `db:init` (`npm run bootstrap`)                                                  |
| `references/MAIN_AGENT_ROUTING.md`      | Main agent → `sessions_send` / `ENRICH` routing notes                                                    |
| `references/OPENCLAW_RUNTIME.md`        | **OpenClaw** session tools, persistent agent, send/poll behavior                                         |
| `references/INSTALL_AUTOMATION.md`      | What the skill can automate vs gateway/CLI-only steps                                                    |
| `references/SETUP_WIZARD.md`            | **Mandatory install layout:** `~/.openclaw/extensions/advisor-lead-gen/`; “set up the lead gen skill” |
| `references/DISTRIBUTION.md`            | **Release / zip:** what to ship, exclude, and how recipient install matches the wizard                   |
| `references/MODEL_DEFAULTS.md`          | **Default LLM:** `anthropic/claude-haiku-4-5` (not Opus) for gateway / agents                            |
| `references/ASSISTANT_GUIDE.md`         | **Chat agents:** try Session Tools first; if blocked, tell user operator steps                           |
