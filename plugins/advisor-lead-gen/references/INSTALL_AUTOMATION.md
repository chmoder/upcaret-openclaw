# Installation automation — split DB + dual plugin

## Plugin responsibilities

This skill now runs as **two plugins**:

- **`enrichment-engine`**: owns dispatch, queue polling, stale handling, and engine job history in `enrichment.db`.
- **`advisor-lead-gen`**: owns advisor-domain schema (`entities`, `advisor_profiles`, `findings`) and orchestrator assets/prompts.

## Install sequence

```bash
# 1) Install and enable both plugins
# If published in your marketplace/registry:
openclaw plugins install enrichment-engine
openclaw plugins install advisor-lead-gen

# If `enrichment-engine` is not published yet, install from an artifact/path instead:
#   openclaw plugins install /path/to/enrichment-engine
openclaw plugins enable enrichment-engine
openclaw plugins enable advisor-lead-gen

# 2) Required key for enrichment (OpenClaw Settings → Environment variables, or:)
openclaw config set env.BRAVE_API_KEY "<your-brave-search-api-key>"
# Optional: only if your gateway uses Firecrawl for web_fetch
# openclaw config set env.FIRECRAWL_API_KEY "<your-firecrawl-api-key>"

# 3) Orchestrator agent registration is automatic at startup

# 4) Recommended for advisor enrichment
openclaw config set agents.defaults.subagents.maxChildrenPerAgent 12
# If this is unset or below 10, initializer auto-sets it to 12.
# If your gateway does not hot-reload config, restart once.

# 5) Allow sandboxed specialist subagents to use the host browser (Playwright).
#    The initializer auto-sets this on first boot — listed here for environments
#    where you pre-stage config before the first gateway start.
openclaw config set agents.defaults.sandbox.browser.allowHostControl true

# 6) Restart gateway (starts engine dispatcher + advisor initializer).
#    On first install expect 3-4 restart cycles while the plugin auto-configures settings.
#    The plugin sets browser.headless=true automatically — no display or manual browser
#    start needed on any platform.
openclaw gateway restart
```

## Breaking schema rebuild

This release uses a new standardized domain schema in `advisors.db`:

- `entities`
- `advisor_profiles`
- `findings`

The old advisor schema is not migrated in-place. Rebuild by re-extracting SEC data:

```bash
cd ~/.openclaw/extensions/advisor-lead-gen
rm -f ~/.openclaw/advisor-lead-gen/advisors.db
npm run extract -- --state <STATE> --limit <N>
```

## Runtime DB split

- **Domain DB**: `~/.openclaw/advisor-lead-gen/advisors.db` (SEC + normalized findings + latest summary fields on `entities`).
- **Engine DB**: `enrichment.db` (jobs, specialist runs, events, queue state/history).

By default `enrichment.db` resolves to `~/.openclaw/enrichment/enrichment.db` unless `ENRICHMENT_ENGINE_DB_PATH` is set.
By default domain DB resolves to `~/.openclaw/advisor-lead-gen/advisors.db` unless `ADVISOR_DOMAIN_DB_PATH` is set.

## Queueing advisors

```bash
node scripts/enqueue-enrich.js --sec-id <SEC_ID>
# or
npm run enqueue -- --sec-id <SEC_ID>
```

This writes `enrichment_jobs` rows in `enrichment.db`. The `enrichment-engine` plugin dispatches them.

## Manual-only requirements

- Provide API secrets (`BRAVE_API_KEY`, optional `FIRECRAWL_API_KEY`).
- Choose and run SEC extract scope (`--state`, `--limit`) for your environment.
- Restart gateway only when your runtime does not pick up config changes live.
- The browser runs headless — no display required on any platform.

## Upgrade flow

```bash
openclaw plugins update enrichment-engine
openclaw plugins update advisor-lead-gen
openclaw gateway restart
```
