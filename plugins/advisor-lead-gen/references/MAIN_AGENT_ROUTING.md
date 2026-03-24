# Main agent routing (intent → orchestrator)

**See also:** [`OPENCLAW_RUNTIME.md`](./OPENCLAW_RUNTIME.md) — orchestrator agent, `sessions_send` / `TICK` (manual recovery only), and why subagents don't replace the orchestrator session.

In OpenClaw, the **main agent** is the primary agent you talk to; its direct chat session commonly uses the session key **`main`** (see [Session Tools](https://docs.openclaw.ai/concepts/session-tool)). That **main agent** should route enrichment work to the **orchestrator** session (recommended `advisor-enrich`; some installs use `lead-gen`).

**Scope:** This document describes how the **main agent** (or any **requesting** agent you configure) should interpret user intent. The `advisor-enrich` orchestrator agent (`IDENTITY.md`) directly handles **`ENRICH:{...}`**, **`TICK`**, **`ENV`**, and **`/leadgen env` / `/leadgen help`** only. Commands like `/leadgen enrich`, export, status, or retry are **your** responsibility to map to `node scripts/extract-advisors.js`, SQL, CSV, or `sessions_send` with `ENRICH:{...}`.

## Supported User Intents

- Natural language:
  - enrich advisors by state/limit
  - advisor lookup by CRD
  - export leads by score
  - status/progress of enrichment runs

- Command format:
  - `/leadgen enrich state=<STATE> limit=<N>`
  - `/leadgen status`
  - `/leadgen advisor crd=<CRD>`
  - `/leadgen export min_score=<0..5> output=<file.csv>`
  - `/leadgen retry failed limit=<N>`
  - `/leadgen env`
  - `/leadgen env help`
  - `/leadgen help`

## Routing Behavior

**Always include `agentId: "advisor-enrich"` in every `sessions_send` to the orchestrator.**

**Use the session key from `sessions_list`.** The default session key is `agent:advisor-enrich:main`. Never hardcode `session:advisor-orchestrator` without first verifying it appears in `sessions_list`. If no session exists, see `SETUP_WIZARD.md` step 3.5. Without it the gateway does not know which agent owns `session:advisor-orchestrator` and may misroute the message or fall back to the default agent.

1. Check `sessions_list` to see if a session for the orchestrator already exists. If nothing shows up, that is fine — `sessions_send` with `agentId` creates the session on first use. Do **not** attempt `sessions_spawn` as a workaround.

2. Send enrichment (fire-and-forget):

   ```
   sessions_send({
     sessionKey: "<key from sessions_list for agentId advisor-enrich>",
     agentId: "advisor-enrich",
     message: "ENRICH:{...advisor json...}",
     timeoutSeconds: 0
   })
   ```

3. Poll with **repeated** `TICK` until `DONE:{...}` appears in history:

   ```
   sessions_send({ sessionKey: "<key from sessions_list for agentId advisor-enrich>", agentId: "advisor-enrich", message: "TICK", timeoutSeconds: 0 })
   sessions_history({ sessionKey: "<key from sessions_list for agentId advisor-enrich>", limit: 10 })
   ```

   Repeat every 2–3 seconds. Stop when the latest assistant message in history contains `DONE:`.

4. For env/config troubleshooting:

   ```
   sessions_send({ sessionKey: "<key from sessions_list for agentId advisor-enrich>", agentId: "advisor-enrich", message: "ENV", timeoutSeconds: 0 })
   ```

5. Summarize progress/results to the user in plain language.

## Error Handling

- If the orchestrator session is missing, instruct operator to create it.
- If required gateway config is missing (`env.BRAVE_API_KEY` / **BRAVE_API_KEY** in Settings), return a clear setup error.
- If partial failures occur, report success/failed counts and suggest `/leadgen retry failed`.
