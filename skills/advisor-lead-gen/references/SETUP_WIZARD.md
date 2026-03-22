# Setup wizard — "set up the lead gen skill"

**Distribution pattern:** copy the skill to one place → chat with OpenClaw → done.  
**Release checklist:** see `references/DISTRIBUTION.md`.

---

## Install location (one path, not two)

```text
~/.openclaw/workspace/skills/advisor-lead-gen/
  SKILL.md          ← main agent loads this for triggering
  package.json
  scripts/
  agents/
  references/
```

The `advisor-enrich` OpenClaw agent's `--workspace` points to **this same directory** — there is no separate `workspace-advisor-enrich/` to copy to. Install once, run from there.

**Container path equivalent:** `/home/node/.openclaw/workspace/skills/advisor-lead-gen/`

---

## Primary flow (chat — no terminal required from the user)

The user starts in **OpenClaw chat** with something like **"set up the lead gen skill"**. The main agent reads this SKILL.md (already in its workspace skills), then:

1. **Runs `npm run bootstrap`** via exec in the skill directory.
2. **Runs `npm run setup:openclaw`** via exec; reads the printed commands.
3. **Executes the `openclaw agents add` command** (or hands it to the user if the CLI is not available from exec).
4. **Starts the orchestrator session** — runs `openclaw agent --agent advisor-enrich --message STATUS --timeout 60` via exec. This step is required before any `sessions_send` from webchat will work. Do not skip it and do not ask the user to do it manually — exec it directly.
5. **Collects `BRAVE_API_KEY`** (and optional keys per `npm run env:help`) in chat — never echo them.
6. **Applies `openclaw config set env.BRAVE_API_KEY`** (or equivalent) via exec or gives exact command.
7. **Verifies** with `sessions_list` → confirm `session:advisor-orchestrator` present → `sessions_send ENV` (with `agentId: "advisor-enrich"`).

**Fallback:** only if exec/CLI is completely unavailable, give the user the operator commands block below.

---

## What the agent executes (ordered)

### 1. Bootstrap

```bash
cd ~/.openclaw/workspace/skills/advisor-lead-gen
npm run bootstrap
```

Idempotent: verifies sqlite3, required scripts, and initialises the DB schema.

### 2. Setup

```bash
npm run setup:openclaw
```

Prints the exact `openclaw agents add advisor-enrich --workspace <this-dir>` command plus env, session, and cron examples. Read the output and execute the printed steps.

### 3. Register agent (from openclaw-setup output)

```bash
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/workspace/skills/advisor-lead-gen \
  --non-interactive \
  --model anthropic/claude-haiku-4-5
```

### 3.5. Start the orchestrator session (REQUIRED before any enrichment)

Webchat can send messages to an **existing** named session, but **cannot create a new one**. The `session:advisor-orchestrator` session must be initialized during setup — otherwise every `sessions_send` from webchat will fail with "session not found."

**Option A — CLI (preferred if exec is available):**
```bash
openclaw agent \
  --agent advisor-enrich \
  --message STATUS \
  --timeout 60
```
This runs one turn of the advisor-enrich agent and creates its session. The session key will appear as `agent:advisor-enrich:main` in `sessions_list`.

**Option B — OpenClaw control UI (only if exec is completely unavailable):** Open a chat with the **advisor-enrich** agent directly and send `STATUS`. That turn creates the session. Return to the main chat once it responds.

Verify: run `sessions_list` from chat and confirm a session with `agentId: "advisor-enrich"` and key `agent:advisor-enrich:main` appears. If no session appears, repeat step 3.5 before proceeding.

### 4. Start the dispatch cron with PM2 (REQUIRED — without it nothing enriches)

`dispatch-cron.js` is the **only** process that sends `ENRICH` to the `advisor-enrich` agent. `enqueue-enrich.js` only writes a DB row — the cron is what actually triggers the agent.

**PM2** is the process manager — same commands on Docker, Linux, macOS, and Windows.

**① Install PM2 (one-time, global):**
```bash
npm install -g pm2
# or via the skill: npm run cron:install
```

**② Start the cron:**
```bash
cd ~/.openclaw/workspace/skills/advisor-lead-gen
pm2 start ecosystem.config.js
pm2 save
# or via the skill: npm run cron:start && npm run cron:save
```

**③ Boot persistence (Linux/macOS, run once):**
```bash
pm2 startup    # prints a command — copy and run it as instructed
pm2 save
```

**For Docker** (run inside the container where `openclaw` CLI lives):
```bash
docker exec <container> npm install -g pm2
docker exec <container> sh -c "cd /home/node/.openclaw/workspace/skills/advisor-lead-gen && pm2 start ecosystem.config.js && pm2 save"
```

**Useful PM2 commands:**
```bash
npm run cron:status    # is it running?
npm run cron:logs      # tail logs
npm run cron:restart   # restart after config changes
npm run cron:stop      # stop cleanly
```

**To queue an advisor** (PM2-managed cron picks it up within 5s):
```bash
node scripts/enqueue-enrich.js --sec-id <SEC_ID>
npm run enqueue -- --sec-id <SEC_ID>
```

**⚠️ Do NOT add a TICK cron job.** TICK races with auto-resume and corrupts saves. TICK is a manual recovery command only — send it by hand if an enrichment is visibly stuck after >5 minutes.

### 5. Apply API key

```bash
openclaw config set env.BRAVE_API_KEY "<key-from-user>"
# newer CLI: openclaw env set BRAVE_API_KEY=<key>
```

### 6. Verify

```javascript
sessions_list()
// Confirm a session with agentId "advisor-enrich" and key "agent:advisor-enrich:main" appears.
// Then verify the orchestrator is healthy:
sessions_send({ sessionKey: "agent:advisor-enrich:main", agentId: "advisor-enrich", message: "STATUS", timeoutSeconds: 0 })
```

---

## Fallback: operator commands (only if exec/CLI unavailable)

### Install from a zip or git clone

```bash
mkdir -p ~/.openclaw/workspace/skills/advisor-lead-gen

# From a zip (extract flat — package.json must be at the root, not nested):
unzip advisor-lead-gen.zip -d ~/.openclaw/workspace/skills/advisor-lead-gen

# Or from a git repo:
rsync -a --exclude node_modules --exclude advisors.db \
  /path/to/upcaret-openclaw-skills/skills/advisor-lead-gen/ \
  ~/.openclaw/workspace/skills/advisor-lead-gen/

cd ~/.openclaw/workspace/skills/advisor-lead-gen
npm run bootstrap
npm run setup:openclaw
```

Then run the printed `openclaw agents add` and `config set env.BRAVE_API_KEY` commands.

---

## What to say if something is impossible from chat

Follow `references/ASSISTANT_GUIDE.md` §3 — numbered, concrete steps. Do **not** claim enrichment ran without `sessions_send` + `DONE:`.

---

## Related docs

- `references/ASSISTANT_GUIDE.md` — enrichment and SEC-only flows
- `references/INSTALL_AUTOMATION.md` — what the skill cannot automate alone
- `references/DISTRIBUTION.md` — release / packaging checklist
- `references/OPENCLAW_RUNTIME.md` — `ENRICH`, `TICK`, `agentId`, named sessions
