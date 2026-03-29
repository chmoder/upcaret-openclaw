# sec-iapd (OpenClaw plugin)

SEC IAPD adapter plugin for the standalone `enrichment` core.

## Dependency

Install and enable `enrichment` first.

## Install

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw plugins install sec-iapd
openclaw plugins enable sec-iapd
openclaw gateway restart
```

## Usage

```bash
npm run import -- --state NE --limit 100
```

Cron-friendly:

```bash
npm run import -- --state NE --limit 100 --quiet
```

Summary is emitted as JSON on stdout for monitoring and automation.

## Integration model

- `sec-iapd` imports advisor profiles and delegates persistence to enrichment's public save CLI (`enrichment/scripts/save-profiles.js`) for writes into `profiles` only.
- `enrichment` is the only plugin that runs enrichment processing.
- Trigger enrichment from chat when you are ready to process imported records.
- `sec-iapd` does not write to enrichment `findings`.

This keeps source ingestion and enrichment orchestration clearly separated.
