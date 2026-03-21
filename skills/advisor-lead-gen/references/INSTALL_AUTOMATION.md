# Installation automation — what the skill can and can’t do

## What OpenClaw must own (not inside this folder)

| Task | Why the skill can’t fully automate it alone |
|------|---------------------------------------------|
| **`openclaw agents add`** | Creates entries in **gateway config** (`openclaw.json`) and workspaces. Requires the **OpenClaw CLI** on the host that runs the gateway. |
| **`openclaw config set env.*` or `openclaw env set`** | Writes **secrets** and gateway env. Must run where your gateway reads config (often the same machine as `openclaw`). |
| **Orchestrator = process with `sessions_*`** | The **agent definition** must point at a workspace that contains this skill and must use whatever boot command your install uses to run the agent loop (see OpenClaw **Agent workspace** + **Multi-Agent Routing** docs). This skill ships **`scripts/orchestrator.js`** but does not register itself as an agent. |
| **`sessions_send` / `TICK` with a real `sessionKey`** | Keys come from **`sessions_list`** at runtime. The skill can document patterns; only a running client (main agent, control UI, gateway) can call session tools. |

## What this skill *does* automate

- **`npm run bootstrap`** — Idempotent: `sqlite3` check, file check, **`db:init`**.
- **`npm run setup:openclaw`** — Prints **copy-paste** commands with **paths filled in** from this install; optionally runs **read-only** `openclaw agents list` if the CLI exists. See `scripts/openclaw-setup.js`.

## “Something better” than SKILL.md alone

1. **ClawHub** — `clawhub install <slug>` gets files into `./skills` (or workspace). Still does not create a second agent or set env.
2. **This repo’s `setup:openclaw` script** — Bridges “docs” → “exact shell commands” for your machine.
3. **Future** — If OpenClaw adds **declarative agent recipes** or **skill post-install hooks** in the gateway, this skill could be extended to match; today that’s platform-side.

## Assistant / operator workflow

1. Run **`npm run bootstrap`** in the skill directory (or after copy into the orchestrator workspace).
2. Run **`npm run setup:openclaw`** and execute or hand off the printed **`openclaw`** commands.
3. Set **`BRAVE_API_KEY`** (and optional keys) via **`openclaw config set env.…`** or **`openclaw env set`** per your OpenClaw version.
4. Confirm **`openclaw agents list`** and **`sessions_list`** show the orchestrator; then use **`sessions_send`** with **`ENRICH:`**.
