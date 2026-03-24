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

### 2) Register orchestrator agent

```bash
openclaw agents add advisor-enrich \
  --workspace ~/.openclaw/extensions/advisor-lead-gen
```

### 3) Configure required API key

In **OpenClaw Settings → Environment variables**, add **`BRAVE_API_KEY`** (Brave Search). That writes the same field as:

```bash
openclaw config set env.BRAVE_API_KEY "<key-from-user>"
```

### 4) Restart gateway

```bash
openclaw gateway restart
```

This starts:

- `enrichment-engine` dispatcher service
- `advisor-lead-gen` initializer service

### 5) Rebuild advisor domain DB (breaking schema change)

```bash
cd ~/.openclaw/extensions/advisor-lead-gen
rm -f advisors.db
npm run bootstrap
npm run extract -- --state <STATE> --limit <N>
```

### 6) Queue an advisor

```bash
node scripts/enqueue-enrich.js --sec-id <SEC_ID>
```

`enqueue-enrich.js` writes to `enrichment_jobs` in `enrichment.db`; dispatcher picks it up automatically.

---

## Runtime DBs

- Domain DB: `advisors.db` (`entities`, `advisor_profiles`, `findings`)
- Engine DB: `enrichment.db` (`enrichment_jobs`, `enrichment_specialist_runs`, `enrichment_events`)

By default `enrichment.db` path is `~/.openclaw/enrichment/enrichment.db` unless overridden with `ENRICHMENT_ENGINE_DB_PATH`.

---

## Session note

Keep using `agentId: "advisor-enrich"` when sending orchestrator messages. Session key is typically `agent:advisor-enrich:main`.
