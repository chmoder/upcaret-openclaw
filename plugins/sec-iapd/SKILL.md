---
name: sec-iapd-import
description: >
  SEC IAPD adapter for enrichment. Use when users ask to import advisors from SEC,
  run IAPD pulls, or schedule SEC ingestion.
---

# SEC IAPD Import Skill

This adapter imports SEC IAPD advisors into the enrichment plugin's `profiles` table.

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
2. Enqueue enrichment (`enrichment/scripts/feed.js` or `enrichment/scripts/enqueue.js`)
3. Watch status (`enrichment/scripts/status-dashboard.js`)
