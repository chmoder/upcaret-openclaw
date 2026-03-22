# Assistant guide — what OpenClaw should do vs what to tell the user

This skill is used from **chat**. The model (main agent) should **try OpenClaw first**, then **tell the user** exactly what’s left when the platform can’t act.

---

## Hard rules — never break these

- **Do not fabricate data.** If `npm run extract` fails or the SEC API is unreachable, stop and report the error. Never generate synthetic/mock advisor rows and present them as real data. An enrichment is only complete when `enriched_at` is NOT null in the DB — not when the orchestrator says something that looks like a result.
- **Do not create new files.** The skill's file list is canonical (see `ARCHITECTURE.md`). Do not write new scripts, workarounds, or agent definition files.
- **Do not write into `~/.openclaw/agents/`.** Never create or modify files in any agent directory (prompts, auth configs, session files). If the orchestrator lacks a system prompt, that is a setup problem — report it and point to `SETUP_WIZARD.md`.
- **Do not install npm packages.** `package.json` has no runtime `dependencies` by design. Never `npm install` anything — not `better-sqlite3`, not `sqlite3`, not anything. If a script says "Cannot find module X", the answer is not to install X; run `node scripts/bootstrap.js` to verify the environment and check that `node --version` is ≥ 22.5 (which provides the built-in `node:sqlite` module).
- **Do not use ad-hoc SQLite access.** Never write `node -e "require('better-sqlite3')..."` or any inline DB code. The only approved DB access paths are `scripts/status-dashboard.js`, `scripts/record-enrichment.js`, `scripts/enqueue-enrich.js`, `scripts/save-enrichment.js`, and `scripts/next-advisor.js`. Use them via `npm run status` or `node scripts/<name>.js`.
- **Do not initialize a git repo** or create `.git/` in the skill directory.
- **Do not create markdown files.** Point the user to existing docs instead.
- **Report failures honestly.** If exec is unavailable, the CLI is missing, or the SEC API is unreachable, say so and give the user exact steps to resolve it. Never silently work around a failure.
- **The dispatch cron must be running for enrichment to work.** Queued rows sit forever if `advisor-cron` is not online in PM2. After setup, always verify with `pm2 status` and confirm `advisor-cron` is `online`. If not, start it: `cd ~/.openclaw/extensions/advisor-lead-gen && pm2 start ecosystem.config.js && pm2 save`.
- **Never tell the user to configure ACP, Discord, or Slack to enable enrichment.** Errors from `sessions_spawn` (including "ACP not configured") mean that approach is wrong — not that enrichment is impossible. The exec path (`openclaw agent --agent advisor-enrich`) works without ACP and without persistent channels. Use it.

---

## 0. When the user asks to set up / install / configure the lead gen skill

Triggers include: **set up the lead gen skill**, **install advisor-lead-gen**, **configure SEC advisor enrichment**, **onboard this skill**.

**Do not ask "which option?" or present a menu. Execute immediately.**

Say something like: "Found the skill — running bootstrap and setup now." Then proceed through steps 1–4 below without waiting for the user to choose.

**One install location:** `~/.openclaw/extensions/advisor-lead-gen/` (container: `/home/node/.openclaw/extensions/advisor-lead-gen/`). The `advisor-enrich` agent's `--workspace` points here. No separate directory needed.

1. Run `npm run bootstrap` via **exec** (cwd = skill dir). Report pass/fail.
2. Run `npm run setup:openclaw` via **exec**; read the output and execute the printed `openclaw agents add advisor-enrich --workspace <dir>` command. If running via Docker, add `-T` to disable TTY: `docker compose run --rm -T openclaw-cli agents add advisor-enrich --workspace /home/node/.openclaw/extensions/advisor-lead-gen`. Do NOT pass `--non-interactive` or `--model` — those flags are not supported in OpenClaw 2026.3+.
3. **Start the orchestrator session** — run `openclaw agent --agent advisor-enrich --message STATUS --timeout 60` via exec. This creates the advisor-enrich agent session. If exec is unavailable, tell the user to open a chat with the advisor-enrich agent and send `STATUS`. This step is required before any webchat enrichment will work.
4. Check if `BRAVE_API_KEY` is already configured: run `openclaw config get env.BRAVE_API_KEY` via exec. If it returns a value, skip to step 5. Otherwise ask the user for the key in chat (one question, not a list of options) then apply: `openclaw config set env.BRAVE_API_KEY "<key>"`.
5. **Start the dispatch cron with PM2** (REQUIRED — without it nothing enriches):
   ```bash
   cd ~/.openclaw/extensions/advisor-lead-gen
   npm install -g pm2                  # one-time; inside Docker: npm install -g pm2 --prefix /usr/local
   pm2 start ecosystem.config.js
   pm2 save
   ```
   Verify it is running: `pm2 status` should show `advisor-cron` as `online`. If `pm2` is not on PATH after install, use `npx --yes pm2 start ecosystem.config.js` as a fallback (it spawns its own daemon under `~/.pm2`). Either way, confirm `advisor-cron` is `online` before telling the user setup is complete.
6. Verify with `sessions_list` → confirm session with `agentId: "advisor-enrich"` present → `sessions_send ENV` (with `agentId: "advisor-enrich"`).

If exec is unavailable, skip to **`SETUP_WIZARD.md`** Fallback block and give the user exact copy-paste commands — still no menu.

---

## 1. When the user asks for enrichment (or SEC + enrich)

**Do not attempt `sessions_spawn` in any form.** Both `thread=true` and one-shot fail in this environment ("ACP not configured", webchat rejected, etc.). That error does not mean enrichment is impossible — it means `sessions_spawn` is the wrong tool. Ignore it and proceed as below.

**Do not mention ACP, Discord, or Slack as requirements.** They are not needed.

### Decision tree — follow in order, stop at first success

**Step 1 — Check for existing session**

```
sessions_list()
```

Look for a session with `agentId: "advisor-enrich"` (key is typically `agent:advisor-enrich:main`).

**If session found → Step 2 (sessions_send)**
**If no session found → run `openclaw agent --agent advisor-enrich --message STATUS --timeout 30` via exec to create it, then go to Step 2. The session key is `agent:advisor-enrich:main`. Do not attempt sessions_spawn.**

---

**Step 2 — Queue the advisor**

Your only job is to write the queue row. The dispatch cron (`dispatch-cron.js`) handles everything else — it polls the queue, resets the session, and fires ENRICH automatically.

```bash
node /home/node/.openclaw/extensions/advisor-lead-gen/scripts/enqueue-enrich.js --sec-id <SEC_ID>
# → QUEUED:<sec_id>
```

The cron picks it up within 5 seconds and fires the ENRICH. Results appear in ~3–5 minutes.

Immediately tell the user: "Queued [Name] for enrichment. The dispatch cron will pick it up within seconds — results appear in ~3–5 minutes. Check status with `npm run status`."

**To queue multiple advisors**, call `enqueue-enrich.js` once per advisor — the cron processes them one at a time:

```bash
node scripts/enqueue-enrich.js --sec-id <ID1>
node scripts/enqueue-enrich.js --sec-id <ID2>
node scripts/enqueue-enrich.js --sec-id <ID3>
```

---

**Step 3 — exec fallback (dispatch cron not running)**

If `dispatch-cron.js` is not running, queue the advisor and fire manually:

```bash
node /home/node/.openclaw/extensions/advisor-lead-gen/scripts/enqueue-enrich.js --sec-id <SEC_ID>
```

```bash
openclaw agent \
  --agent advisor-enrich \
  --message 'ENRICH:<json from dispatch output>' \
  --timeout 30
```

The orchestrator will reply that it has started. That is sufficient — do not wait for DONE. Tell the user to check the DB in ~5 minutes.

**To check DB status anytime:**

```
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/node/.openclaw/extensions/advisor-lead-gen/advisors.db');console.log(JSON.stringify(db.prepare('SELECT sec_id,name,lead_score,enriched_at FROM advisors WHERE enriched_at IS NOT NULL ORDER BY enriched_at DESC LIMIT 10').all()))"
```

**Step 4 — if exec is also unavailable**

Tell the user (one short numbered list, no menus):

1. Start the dispatch cron: `node scripts/dispatch-cron.js` (it picks up queued rows automatically)
2. Or manually: `openclaw agent --agent advisor-enrich --message 'ENRICH:{...}' --timeout 30`
3. Check the DB in ~5 minutes.

Do not tell the user to configure ACP, Discord, or Slack.

### D. Cron jobs must pin the orchestrator agent

## If the user uses **OpenClaw cron**, each job must set **`agentId: "advisor-enrich"`**. Without it, the gateway runs the job as the default agent — wrong workspace. See `npm run setup:openclaw` output for the correct JSON shape.

## 2. When the user asks for SEC download only

- If you have a **terminal/exec** tool whose cwd can be the skill workspace: you may run `npm run extract -- --state … --limit …` (no API keys required).
- If you **don't** have shell access: **tell the user** an operator must run `npm run extract` (or `node scripts/extract-advisors.js`) where `advisors.db` lives, or grant you exec in that workspace.

### No npm install is needed — ever

This skill has **no runtime npm dependencies**. All database operations use the **`node:sqlite`** module built into Node 22.5+. Do **not** run `npm install` for any reason. If you see “Cannot find module 'better-sqlite3'” or “Cannot find module 'sqlite3'”, those are the wrong modules — never install them. If a script fails to load its DB module, run `node scripts/bootstrap.js` to verify the environment (`node --version` must be ≥ 22.5).

---

## 3. What to tell the user (operator / gateway)

When OpenClaw **cannot** create agents, set gateway env, or copy files:

Give a **short, numbered** list. Do not use vague “configure the server.” Prefer:

1. On the **gateway host** where OpenClaw runs, open a terminal in the skill directory (or path where `advisor-lead-gen` was installed).
2. Run **`npm run bootstrap`** then **`npm run setup:openclaw`** and execute or hand off the printed commands (`openclaw agents add`, `openclaw config set env.BRAVE_API_KEY`, copy into workspace).
3. Restart or reload the gateway if your install requires it after config changes.
4. Return to chat and ask again — you will **`sessions_list`** / **`sessions_send`** as in section 1.

Optional: if **`BRAVE_API_KEY`** is the only gap and the user can paste it, suggest they set it via **`openclaw config set env.BRAVE_API_KEY "…"`** or **`openclaw env set`** (per their CLI version).

---

## 4. Tone

- **Never** imply enrichment succeeded if **`sessions_send`** never reached a live orchestrator session.
- **Distinguish** “I don’t have tools to fix this” from “the orchestrator returned an error” — different user actions.
