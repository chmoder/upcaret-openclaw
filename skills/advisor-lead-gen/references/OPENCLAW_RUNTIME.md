# OpenClaw runtime (this skill)

This skill’s enrichment path is **only** meaningful inside an **OpenClaw agent session** that exposes **Session Tools**. Running a plain Node.js subprocess does not provide `sessions_spawn` / `sessions_yield` / `sessions_history`, so the agent-to-agent pipeline cannot complete.

**Official reference:** [Session Tools — OpenClaw docs](https://docs.openclaw.ai/concepts/session-tool) (`sessions_list`, `sessions_send`, `sessions_spawn`, `sessions_history`).

---

## 1. Where the orchestrator must run

The enrichment orchestrator is implemented by **`IDENTITY.md`** (the system prompt for the `advisor-enrich` agent).

| Requirement | Why |
|-------------|-----|
| **Persistent agent** (e.g. `advisor-enrich`) with this skill in its **workspace** | The orchestrator is designed to stay alive across many `ENRICH` / `TICK` turns. |
| **Session Tools available** in that agent’s runtime | Specialists are created with `sessions_spawn`; progress uses `sessions_yield` and `sessions_history` (defined in `IDENTITY.md`). |

**Do not** rely on a **subagent** or generic child process to “run the orchestrator” unless that child has the **same** session-tool surface. Sub-agent sessions follow different rules (e.g. nesting / tool allowlists); the supported pattern is: **one dedicated orchestrator agent**, and the **main agent** or **gateway / control UI** sends work **into** that session via `sessions_send`.

---

## 2. `sessions_send` for enrichment

**Always pass `agentId: "advisor-enrich"`** in every `sessions_send` to the orchestrator. Without it the gateway does not know which agent owns `session:advisor-orchestrator` and may fall back to the default agent (wrong workspace, no enrichment).

```
sessions_send({
  sessionKey: "session:advisor-orchestrator",
  agentId: "advisor-enrich",
  message: "ENRICH:{...advisor json...}",
  timeoutSeconds: 0
})
```

- **Session does not exist yet?** That is fine. `sessions_send` with `agentId` creates the named session on first use. Do **not** use `sessions_spawn` as a workaround.
- **Long runs:** prefer `timeoutSeconds: 0` (fire-and-forget). Follow up with repeated `TICK` + `sessions_history` checks.
- **Message contract for this skill:**
  - `ENRICH:{...advisor json...}` — start / continue enrichment for one advisor.
  - `TICK` — advance pending work (orchestrator polls child results).
  - `ENV`, `/leadgen env`, `/leadgen help` — env/help (handled by the orchestrator agent).

---

## 3. Sessions and cron

The `advisor-enrich` agent session is created the first time a turn runs for it. The default session key is **`agent:advisor-enrich:main`** (created by `openclaw agent --agent advisor-enrich --message STATUS --timeout 60`). This is the key the main agent should use in `sessions_send` after discovering it via `sessions_list`.

OpenClaw also supports **custom named sessions** with keys like **`session:your-id`** that are independent of chat threads — useful for cron and control UIs. If your install uses a named session key, it will appear in `sessions_list` with `agentId: "advisor-enrich"`. Always discover the session key dynamically from `sessions_list`; never hardcode `session:advisor-orchestrator` without checking first.

You **do not** need a separate long-running process. Each scheduled **`agentTurn`** (or each **`sessions_send`**) is a **wake-up**: the gateway runs a **turn** for the agent you specify. The session **persists transcript/context** between turns.

### Required: `agentId` on every orchestrator cron job

Per [OpenClaw cron jobs](https://docs.openclaw.ai/cron), jobs may include **`agentId`**: run under that agent; **if missing or unknown, the gateway falls back to the default agent** (often `main`). That wrong agent will **not** have the advisor workspace or orchestrator skill — enrichment will silently fail or mis-route.

| Field | Role |
|--------|------|
| **`sessionTarget`** | Session key to use (e.g. whatever `sessions_list` shows for advisor-enrich). |
| **`agentId`: `"advisor-enrich"`** | **Which agent** runs the turn — **required** for reliable enrichment. |
| **`payload.kind`**: **`agentTurn`** | Carries **`message`** (`ENRICH:…`, **`TICK`**, etc.). |

CLI equivalent: **`openclaw cron add … --agent advisor-enrich`** (see cron docs). **`npm run setup:openclaw`** prints JSON and CLI examples with **`agentId`**.

**Still required:** after **`ENRICH`**, send **`TICK`** (repeat until **`DONE:`** in **`sessions_history`**) unless your automation already advances the orchestrator another way.

**Verify:** **`STATUS`**, **`ENV`**, and SQLite checks on **`advisors.db`** (see `SKILL.md`).

Confirm **schedule JSON** and field names against **your OpenClaw version** — the setup script shows an illustrative shape only.

## 4. `sessions_spawn` behavior (orchestrator internals)

- **`sessions_spawn` is non-blocking** — returns immediately with a child session reference; specialists run asynchronously.
- The orchestrator **yields** and **polls** (pending rows + history) — that matches the platform model; don’t assume a single synchronous `sessions_send` wait will return the final `DONE:` for a full enrich unless your timeout and runtime allow it.

---

## 5. Channels and UI

- **Webchat works for enrichment.** The main webchat agent does not need to be persistent — it uses `sessions_send` (with `agentId: "advisor-enrich"`) to delegate to the `advisor-enrich` orchestrator, which holds the persistent session. Never tell a user to switch to Discord/Slack because of session limitations.
- If enrichment “isn’t active,” the most likely cause is a missing `agentId: "advisor-enrich"` in the `sessions_send` call — the gateway falls back to the default agent (wrong workspace). Verify `agentId` is present before debugging anything else.

---

## 6. Main agent vs orchestrator responsibilities

- **Orchestrator session:** `ENRICH` / `TICK` / env messages only (see `MAIN_AGENT_ROUTING.md`).
- **Main agent** (primary agent you chat with; direct chat session key is often `main`): natural language and `/leadgen …` commands → map to **`extract-advisors.js`**, SQL/CSV, or **`sessions_send`** with `ENRICH:{...}` built from `advisors.db`.

This split avoids duplicating policy inside the orchestrator while keeping a single enrichment contract.

---

## Local skill bootstrap (idempotent)

After copying this skill into an agent workspace, run **`npm run bootstrap`** once (or anytime). It verifies required files and runs **`db-init`** (safe to repeat). It does **not** create OpenClaw agents or set gateway environment variables.
