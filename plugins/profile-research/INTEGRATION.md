# Profile Research -> Enrichment Integration

**TL;DR:** `profile-research` (and `sec-iapd`) retrieve and store profile data in `profiles` as pending records.  
`enrichment` is the only plugin that performs enrichment.

## Architecture

1. **profile-researcher** agent discovers profiles via web search.
2. **save-profiles.js** delegates persistence to enrichment's public save CLI (`enrichment/scripts/save-profiles.js`) and writes `profiles` only.
3. **enrichment** is invoked from chat when the user wants enrichment processing to run.

## Workflow

### Step 1: Save profiles
```bash
node scripts/save-profiles.js '<json payload>'
# Output: SAVED:{"inserted": 5, "updated": 0, "skipped": 2, ...}
```

### Step 2: Trigger enrichment from chat
- Ask in chat to run enrichment for newly saved profiles.
- Newly inserted records are saved with `enriched_at = NULL` and `enrichment_status = 'pending'`.
- Keep enrichment execution in the enrichment plugin layer.

## Data Flow

```
profile-researcher / sec-iapd
    ->
save-profiles.js (adapter)
    ->
enrichment save-profiles.js (public entrypoint)
    ->
enrichment DB (profiles only)
    ->
enrichment plugin (invoked via chat)
```

## Governance Principle

✅ **Correct:** retrieval plugins collect/store data; enrichment plugin enriches data.

This separation keeps responsibilities clear:
- Retrieval and persistence stay lightweight in source adapters.
- Enrichment logic, policy, and orchestration stay centralized in `enrichment`.
