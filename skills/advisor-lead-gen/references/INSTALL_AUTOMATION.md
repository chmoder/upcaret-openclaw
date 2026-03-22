# Installation automation — what the skill can and can't do

## What OpenClaw must own (not inside this folder)

| Task | Why the skill can't fully automate it alone |
|------|---------------------------------------------|
| **`openclaw agents add`** | Creates entries in gateway config (`openclaw.json`) and workspaces. Requires the **OpenClaw CLI** on the host that runs the gateway. |
| **`openclaw config set env.*` or `openclaw env set`** | Writes secrets and gateway env. Must run where your gateway reads config (often the same machine as `openclaw`). |
| **Orchestrator = process with `sessions_*`** | The `advisor-enrich` agent must use **this skill's directory** as its workspace (`~/.openclaw/workspace/skills/advisor-lead-gen`). The orchestrator is the `advisor-enrich` agent whose system prompt is `IDENTITY.md`. This skill does not self-register as an agent. |
| **`sessions_send` / `TICK` with a real `sessionKey`** | Keys come from `sessions_list` at runtime. The skill can document patterns; only a running client (main agent, control UI, gateway) can call session tools. |
| **Named persistent session + cron** | OpenClaw routes `agentTurn` jobs using `sessionTarget` (e.g. `session:advisor-orchestrator`). You must set `agentId` on each job to `advisor-enrich` (or your orchestrator id); otherwise the gateway may fall back to the default agent ([cron docs](https://docs.openclaw.ai/cron)). There is no separate "bind agent to session forever" line in `openclaw.json` — **per-job `agentId`** is the binding. |

## What this skill *does* automate

- **`npm run bootstrap`** — Idempotent: `sqlite3` check, file check, `db:init`.
- **`npm run setup:openclaw`** — Prints the exact `openclaw agents add advisor-enrich --workspace <this-dir>` command, env/session/cron examples; optionally runs `openclaw agents list` if the CLI is available.

## "Something better" than SKILL.md alone

1. **ClawHub** — `clawhub install <slug>` gets files into `./skills` (or workspace). Still does not create a second agent or set env.
2. **This repo's `setup:openclaw` script** — Bridges "docs" → "exact shell commands" for your machine.
3. **Future** — If OpenClaw adds declarative agent recipes or skill post-install hooks in the gateway, this skill could be extended to match; today that's platform-side.

## Assistant / operator workflow

1. Place the skill at `~/.openclaw/workspace/skills/advisor-lead-gen/` (zip extract or rsync). `package.json` must be at that directory's root.
2. Run `npm run bootstrap` there.
3. Run `npm run setup:openclaw` and execute or hand off the printed `openclaw agents add` command (workspace = the same directory).
4. Set `BRAVE_API_KEY` (and optional keys) via `openclaw config set env.…` or `openclaw env set` per your OpenClaw version.
5. **Install PM2 and start the dispatch cron** — `dispatch-cron.js` is the **only** process that sends `ENRICH` to the agent. Without it running, nothing ever enriches. PM2 keeps it alive across crashes and reboots — same on Docker, Linux, macOS, Windows.
   ```bash
   npm install -g pm2                          # one-time global install
   cd ~/.openclaw/workspace/skills/advisor-lead-gen
   pm2 start ecosystem.config.js              # start managed by PM2
   pm2 startup && pm2 save                    # survive reboots (Linux/macOS)
   ```
   For Docker (run inside the container):
   ```bash
   docker exec <container> npm install -g pm2
   docker exec <container> sh -c "cd /home/node/.openclaw/workspace/skills/advisor-lead-gen && pm2 start ecosystem.config.js && pm2 save"
   ```
6. **Queue advisors for enrichment** — the cron picks them up within 5s:
   ```bash
   node scripts/enqueue-enrich.js --sec-id <SEC_ID>
   ```
7. Confirm with `openclaw agents list`. Results arrive in ~3–5 min per advisor (see `references/OPENCLAW_RUNTIME.md`).

**⚠️ Do not add a TICK cron job.** TICK races with auto-resume and corrupts saves. Use TICK manually only if an enrichment is stuck after >5 minutes.
