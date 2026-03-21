# Main agent routing (intent → orchestrator)

**See also:** [`OPENCLAW_RUNTIME.md`](./OPENCLAW_RUNTIME.md) — persistent orchestrator agent, `sessions_send` / `TICK`, and why subagents don’t replace the orchestrator session.

In OpenClaw, the **main agent** is the primary agent you talk to; its direct chat session commonly uses the session key **`main`** (see [Session Tools](https://docs.openclaw.ai/concepts/session-tool)). That **main agent** should route enrichment work to the **orchestrator** session (recommended `advisor-enrich`; some installs use `lead-gen`).

**Scope:** This document describes how the **main agent** (or any **requesting** agent you configure) should interpret user intent. The skill’s `scripts/orchestrator.js` session directly handles **`ENRICH:{...}`**, **`TICK`**, **`ENV`**, and **`/leadgen env` / `/leadgen help`** only. Commands like `/leadgen enrich`, export, status, or retry are **your** responsibility to map to `node scripts/extract-advisors.js`, SQL, CSV, or `sessions_send` with `ENRICH:{...}`.

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

1. For enrichment requests, first resolve the orchestrator’s **real `sessionKey`** via `sessions_list` (do not assume the label/id is the sessionKey).

2. Send enrichment (fire-and-forget):
   `sessions_send({ sessionKey: "<orchestratorSessionKey>", message: "ENRICH:{...}", timeoutSeconds: 0 })`

3. Poll by driving the orchestrator state machine with **repeated** `TICK` until you see `DONE:{...}` in `sessions_history`:
   - every 2–3 seconds: `sessions_send({ sessionKey: "<orchestratorSessionKey>", message: "TICK", timeoutSeconds: 0 })`
   - then: `sessions_history({ sessionKey: "<orchestratorSessionKey>", limit: 10 })`
   - stop when the most recent assistant message contains `DONE:`

4. For env/config troubleshooting, route:
   `sessions_send({ sessionKey: "<orchestratorSessionKey>", message: "ENV", timeoutSeconds: 0 })`
   (or `"ENV:HELP"` for a full help text)

5. Summarize progress/results to the user in plain language.

## Validation Defaults

- default `state=NE`
- default `limit=100`
- validate `state` is 2 uppercase letters
- validate `limit` is integer 1..1000
- for advisor lookup require `crd`
- for export default `min_score=0` and `output=leadgen-<timestamp>.csv`

## Error Handling

- If the orchestrator session is missing, instruct operator to create it.
- If required env (`BRAVE_API_KEY`) is missing, return a clear setup error.
- If partial failures occur, report success/failed counts and suggest `/leadgen retry failed`.
