# Setup wizard — "set up the lead gen skill"

This setup now requires **two plugins** and uses a **split DB** model:

- `enrichment-engine` (dispatch + queue + run history in `enrichment.db`)
- `advisor-lead-gen` (advisor domain tables + orchestrator prompts)

---

## Install locations

After `openclaw plugins install`:

```text
~/.openclaw/extensions/enrichment-engine/
~/.openclaw/extensions/advisor-lead-gen/
```

The `advisor-enrich` agent workspace is:

```text
~/.openclaw/extensions/advisor-lead-gen/
```

---

## Operator steps (ordered)

### 1) Install + enable both plugins

```bash
# If published in your marketplace/registry:
openclaw plugins install enrichment-engine
openclaw plugins install advisor-lead-gen

# If `enrichment-engine` is not published yet, install from an artifact/path instead:
#   openclaw plugins install /path/to/enrichment-engine
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen
```

`advisor-enrich` agent registration is automatic at startup.

### 2) Configure required API key

In **OpenClaw Settings → Environment variables**, add **`BRAVE_API_KEY`** (Brave Search). That writes the same field as:

```bash
openclaw config set env.BRAVE_API_KEY "<key-from-user>"
```

**Optional — Firecrawl:** If your OpenClaw gateway routes `web_fetch` through [Firecrawl](https://www.firecrawl.dev/), add the same way:

```bash
openclaw config set env.FIRECRAWL_API_KEY "<key-from-user>"
```

### 3) Restart gateway (expect 3–4 cycles)

The plugin startup auto-configures several settings on first install. Each change
requires a gateway restart to take effect, so the first-install cycle looks like this:

```bash
openclaw gateway restart   # cycle 1 — auto-sets maxChildrenPerAgent=12
openclaw gateway restart   # cycle 2 — registers markitdown MCP server (with env.PATH)
openclaw gateway restart   # cycle 3 — enables agents.defaults.sandbox.browser.allowHostControl=true
openclaw gateway restart   # cycle 4 — pins both plugins in plugins.allow
# cycle 5+ — fully initialized; logs show:
#   Browser started (specialists can use browser tool)
#   advisor-lead-gen initialized (agent=advisor-enrich)
#   enrichment-engine dispatcher started (poll=5000ms stale=10min ...)
```

You can check readiness at any point with:

```bash
openclaw logs --limit 30 --plain --no-color | grep -E "initialized|stale=|error"
```

When you see `advisor-lead-gen initialized` with **no error lines above it**, setup is complete.

> **Note:** On subsequent restarts all `ensure*` checks are idempotent — no extra cycles needed.

> **`uvx` install is automated:** on first boot the plugin detects whether `uvx` is present and
> runs the [uv installer](https://docs.astral.sh/uv/getting-started/installation/) automatically
> (falling back to `pip install uv`). No manual step needed on Umbrel/Docker.

> **Browser (Playwright) runs headless automatically:** `advisor-lead-gen` sets `browser.headless=true`
> in config on first install. The browser launches itself on first `browser navigate` call — no
> display, no Xvfb, no manual start required on any platform.

This starts:

- `enrichment-engine` dispatcher service
- `advisor-lead-gen` initializer service
- `markitdown` MCP server (lazy — starts on first tool call)
- OpenClaw browser (Playwright/Chromium — headless, auto-launches on first `browser navigate` call)

### 4) Rebuild advisor domain DB (breaking schema change)

```bash
cd ~/.openclaw/extensions/advisor-lead-gen
rm -f ~/.openclaw/advisor-lead-gen/advisors.db
npm run extract -- --state <STATE> --limit <N>
```

### 5) Queue an advisor

```bash
node scripts/enqueue-enrich.js --sec-id <SEC_ID>
```

`enqueue-enrich.js` writes to `enrichment_jobs` in `enrichment.db`; dispatcher picks it up automatically.

---

## Runtime DBs

- Domain DB: `~/.openclaw/advisor-lead-gen/advisors.db` (`entities`, `advisor_profiles`, `findings`)
- Engine DB: `enrichment.db` (`enrichment_jobs`, `enrichment_specialist_runs`, `enrichment_events`)

By default `enrichment.db` path is `~/.openclaw/enrichment/enrichment.db` unless overridden with `ENRICHMENT_ENGINE_DB_PATH`.
By default domain DB path is `~/.openclaw/advisor-lead-gen/advisors.db` unless overridden with `ADVISOR_DOMAIN_DB_PATH`.

---

## Session note

Keep using `agentId: "advisor-enrich"` when sending orchestrator messages. Session key is typically `agent:advisor-enrich:main`.

## Manual-only requirements

- API secrets remain operator-provided (`BRAVE_API_KEY`, optional `FIRECRAWL_API_KEY`).
- Data seeding remains operator-driven (`npm run extract -- --state <STATE> --limit <N>`).
- Gateway restarts (3–4 on first install) are required; subsequent restarts are single-cycle.
- The browser runs headless (no display required). No extra setup needed on any platform.
