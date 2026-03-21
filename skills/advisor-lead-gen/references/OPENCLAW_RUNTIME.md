# OpenClaw runtime (this skill)

This skill’s enrichment path is **only** meaningful inside an **OpenClaw agent session** that exposes **Session Tools**. Plain `node scripts/orchestrator.js` in a shell or a one-off subprocess **does not** provide `sessions_spawn` / `sessions_yield` / `sessions_history`, so the agent-to-agent pipeline cannot complete.

**Official reference:** [Session Tools — OpenClaw docs](https://docs.openclaw.ai/concepts/session-tool) (`sessions_list`, `sessions_send`, `sessions_spawn`, `sessions_history`).

---

## 1. Where `orchestrator.js` must run

| Requirement | Why |
|-------------|-----|
| **Persistent agent** (e.g. `advisor-enrich`, `lead-gen`) with this skill in its **workspace** | The orchestrator is designed to stay alive across many `ENRICH` / `TICK` turns. |
| **Session Tools available** in that agent’s runtime | Specialists are created with `sessions_spawn`; progress uses `sessions_yield` and `sessions_history` (see `scripts/orchestrator.js`). |

**Do not** rely on a **subagent** or generic child process to “run the orchestrator” unless that child has the **same** session-tool surface. Sub-agent sessions follow different rules (e.g. nesting / tool allowlists); the supported pattern is: **one dedicated orchestrator agent**, and the **main agent** or **gateway / control UI** sends work **into** that session via `sessions_send`.

---

## 2. `sessions_send` for enrichment

- Use the **real `sessionKey`** for your orchestrator agent (discover via `sessions_list` if unsure). Examples in docs use labels like `advisor-enrich` or `lead-gen` — your install must match **your** configured key.
- **Long runs:** prefer `timeoutSeconds: 0` (fire-and-forget enqueue). Waiting with a large `timeoutSeconds` can still **time out** while work continues; the docs recommend following up with **`sessions_history`** on the target session.
- **Message contract for this skill:**
  - `ENRICH:{...advisor json...}` — start / continue enrichment for one advisor.
  - `TICK` — advance pending work (orchestrator polls child results).
  - `ENV`, `/leadgen env`, `/leadgen help` — env/help (handled in `orchestrator.js`).

---

## 3. `sessions_spawn` behavior (orchestrator internals)

- **`sessions_spawn` is non-blocking** — returns immediately with a child session reference; specialists run asynchronously.
- The orchestrator **yields** and **polls** (pending rows + history) — that matches the platform model; don’t assume a single synchronous `sessions_send` wait will return the final `DONE:` for a full enrich unless your timeout and runtime allow it.

---

## 4. Channels and UI caveats

- Some features (e.g. **thread**-bound routing, certain **mode** flags) depend on **channel/plugin** support. **Webchat** may not support the same options as internal or gateway clients.
- If enrichment “isn’t active,” verify the **orchestrator agent session exists and is the correct `sessionKey`**, not only that an agent definition exists in config.

---

## 5. Main agent vs orchestrator responsibilities

- **Orchestrator session:** `ENRICH` / `TICK` / env messages only (see `MAIN_AGENT_ROUTING.md`).
- **Main agent** (primary agent you chat with; direct chat session key is often `main`): natural language and `/leadgen …` commands → map to **`extract-advisors.js`**, SQL/CSV, or **`sessions_send`** with `ENRICH:{...}` built from `advisors.db`.

This split avoids duplicating policy inside `orchestrator.js` while keeping a single enrichment contract.

---

## Local skill bootstrap (idempotent)

After copying this skill into an agent workspace, run **`npm run bootstrap`** once (or anytime). It verifies `sqlite3`, required files, and runs **`db-init`** (safe to repeat). It does **not** create OpenClaw agents or set gateway environment variables.
