# Assistant guide — what OpenClaw should do vs what to tell the user

This skill is used from **chat**. The model (main agent) should **try OpenClaw first**, then **tell the user** exactly what’s left when the platform can’t act.

---

## 1. When the user asks for enrichment (or SEC + enrich)

### A. Use OpenClaw Session Tools if available

1. **`sessions_list`** — Find a session for the enrichment orchestrator (names vary: `lead-gen`, `advisor-enrich`, or entries tied to the orchestrator agent).  
   - **If no plausible orchestrator session:** do **not** claim enrichment ran. Say the orchestrator isn’t available and give **user-facing** steps (section 3 below).

2. **`sessions_send`** to that orchestrator’s **`sessionKey`**:
   - `message: "ENV"` or `"/leadgen env"` if the user needs config status (orchestrator returns `DONE` with env payload).
   - `message: 'ENRICH:{...}'` with advisor JSON from `advisors` / user, **`timeoutSeconds: 0`**.
   - If you don’t see `DONE:` shortly after, **drive the state machine**:
     - loop every 2–3 seconds: **`sessions_send`** `message: "TICK"` with **`timeoutSeconds: 0`**
     - after each TICK: check **`sessions_history`** on the orchestrator session for a `DONE:{...}` response
     - stop when you see `DONE:` or after a reasonable timeout; report clearly if it times out

3. If **`sessions_send`** errors (session not found, denied, etc.): go to **section 3**.

### B. Do not pretend subagents replace the orchestrator

Do **not** spawn a generic subagent to `node scripts/orchestrator.js` and expect full enrichment — the orchestrator **must** run in a session that has **`sessions_spawn` / `sessions_yield` / `sessions_history`**. If you tried that and it failed, say so and point to the orchestrator session setup (section 3).

---

## 2. When the user asks for SEC download only

- If you have a **terminal/exec** tool whose cwd can be the skill workspace: you may run `npm run extract -- --state … --limit …` (no API keys required).
- If you **don’t** have shell access: **tell the user** an operator must run `npm run extract` (or `node scripts/extract-advisors.js`) where `advisors.db` lives, or grant you exec in that workspace.

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
