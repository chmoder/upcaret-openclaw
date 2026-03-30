---
name: profile-research
description: >
  General-purpose profile discovery and collection. Use when users ask to find
  profile data for people, groups by trade/company/location, networks, or event rosters.
---

# Profile Research Skill

This plugin discovers and collects profile data from the web, then saves it into
the enrichment database (`profiles` only) via enrichment's public save CLI.

Dependency: `enrichment` plugin must be installed and enabled first.
On gateway startup, `profile-research` auto-registers the `profile-researcher` agent.

## Typical prompts

- Find certified financial planners in Austin, TX.
- Find people working in insurance at Berkshire Hathaway.
- Find John Smith's professional network and affiliations.
- Find speakers from the 2025 Wealth Management Summit.
- Find advisors in Omaha at independent RIAs.

## Direct invocation

Spawn the `profile-researcher` agent as a sub-agent using `sessions_spawn`, or invoke it via CLI:

```bash
openclaw agent --agent profile-researcher --message "Find financial advisors in Omaha"
```

**Important:** Always use `sessions_spawn` with `agentId: "profile-researcher"` when delegating from the main agent. Do not attempt the research yourself.

**Completion check:** A successful research run must execute `scripts/save-profiles.js` and finish with the JSON object defined in `agents/researcher.md`. If the child returns only prose or a markdown report, treat the task as **incomplete** (profiles were not persisted) and re-run or save manually from structured data.

## Integration with enrichment

Discovered profiles flow **only into enrichment**:

1. **Save profiles** to enrichment `profiles` table:
   ```bash
   node scripts/save-profiles.js '<json payload>'
   ```
   Newly inserted profiles are marked pending (`enriched_at = NULL`, `enrichment_status = 'pending'`). Updates preserve existing enrichment state.
   Identity is keyed on `source_system + source_key` and persisted by enrichment-owned policy.
   This adapter does not write to the enrichment `findings` table.

2. **Invoke enrichment from chat** when you want processing to run.
   - Keep `profile-research` focused on retrieval + persistence.
   - Let `enrichment` own enrichment orchestration.

Input payload to `save-profiles.js` can be:
- A single profile object
- An array of profile objects
- A wrapper object: `{ "profiles": [ ... ] }`

Each profile should include:

```json
{
  "display_name": "John Doe",
  "first_name": "John",
  "last_name": "Doe",
  "current_employer": "Acme Corp",
  "current_title": "Senior Advisor",
  "location_city": "Omaha",
  "location_state": "NE",
  "location_country": "US",
  "industry": "Finance",
  "source_url": "https://..."
}
```

## Runtime behavior

- Generate up to 3 high-quality queries.
- Use web search to find promising pages.
- Render as many high-likelihood pages as needed.
- If needed, follow links up to 2 additional rounds.
- Save discovered profiles to enrichment database (profiles table only).
- Ask the user to invoke enrichment in chat when ready.
- Summarize results and report any continuation plans.
- If significantly more profiles are available, report that and propose a continuation plan.
- If unsuccessful after retries, respond that it was unable to find information.
