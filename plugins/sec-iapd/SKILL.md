---
name: sec-iapd-import
description: >
  SEC IAPD adapter for enrichment. Use when users ask to import advisors from SEC,
  run IAPD pulls, or schedule SEC ingestion.
---

# SEC IAPD Import Skill

This adapter imports SEC IAPD advisors into the enrichment plugin's `profiles` table only, via enrichment's public save CLI.

Dependency: `enrichment` plugin must be installed and enabled first.

## Import command

```bash
node scripts/import-advisors.js --state NE --limit 100
```

## Cron-friendly mode

```bash
node scripts/import-advisors.js --state CA --limit 200 --quiet
```

The script prints a JSON summary line with counts and `exit_code`.

## Typical chain

1. Import from SEC (`import-advisors.js`)
2. Invoke enrichment from chat when processing should run
3. Watch status (`enrichment/scripts/status-dashboard.js`)

## Responsibility split

- `sec-iapd`: source retrieval plus calls into enrichment-owned save entrypoint
- `enrichment`: enrichment execution, orchestration, and downstream processing

Keep enrichment execution in the enrichment layer so source adapters stay focused on collection quality and data integrity.
`sec-iapd` does not write to enrichment `findings`.
