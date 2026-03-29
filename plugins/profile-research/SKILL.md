---
name: profile-research
description: >
  General-purpose profile discovery and collection. Use when users ask to find
  profile data for people, groups by trade/company/location, networks, or event rosters.
---

# Profile Research Skill

This plugin discovers and collects profile data from the web, then saves it into
the enrichment database (`profiles` + `findings`).

Dependency: `enrichment` plugin must be installed and enabled first.
On gateway startup, `profile-research` auto-registers the `profile-researcher` agent.

## Typical prompts

- Find certified financial planners in Austin, TX.
- Find people working in insurance at Berkshire Hathaway.
- Find John Smith's professional network and affiliations.
- Find speakers from the 2025 Wealth Management Summit.
- Find advisors in Omaha at independent RIAs.

## Direct invocation

```bash
openclaw agent --agent profile-researcher --message "Find financial advisors in Omaha"
```

## Save script

The agent should persist results through:

```bash
node scripts/save-profiles.js '<json payload>'
```

or

```bash
node scripts/save-profiles.js --file <payload.json>
```

Input payload can be a single object, an array of profile objects, or:

```json
{ "profiles": [ ... ] }
```

## Runtime behavior

- Generate up to 3 high-quality queries.
- Use web search to find promising pages.
- Render as many high-likelihood pages as needed.
- If needed, follow links up to 2 additional rounds.
- Save discovered profiles/findings and summarize results.
- If significantly more profiles are available, report that and propose a continuation plan.
- If unsuccessful after retries, respond that it was unable to find information.
