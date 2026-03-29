# SEC IAPD -> Enrichment Integration

**TL;DR:** `sec-iapd` retrieves and stores source records.  
`enrichment` is the only plugin that performs enrichment.

## Architecture

1. **import-advisors.js** fetches advisor data from SEC IAPD.
2. **sec-iapd** upserts records into enrichment-backed table (`profiles` only).
3. **enrichment** is invoked from chat when processing should run.

## Workflow

### Step 1: Import and save
```bash
node scripts/import-advisors.js --state NE --limit 100
```

### Step 2: Trigger enrichment from chat
- Ask in chat to run enrichment for imported profiles.
- Keep enrichment execution in the enrichment plugin layer.

## Data Flow

```
SEC IAPD API
    ->
sec-iapd import script
    ->
enrichment DB (profiles)
    ->
enrichment plugin (invoked via chat)
```

## Governance Principle

✅ **Correct:** source adapters collect/store data; enrichment plugin enriches data.

`sec-iapd` does not write to enrichment `findings`.

This separation keeps responsibilities clear:
- Source adapters stay focused on retrieval quality and persistence.
- Enrichment orchestration and execution stay centralized in `enrichment`.
