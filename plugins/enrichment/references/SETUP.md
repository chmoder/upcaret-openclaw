# Enrichment Setup Notes

Minimum setup:

1. Install and enable plugin.
2. Restart gateway.
3. Ensure profiles exist in DB (`profiles` table).
4. Enqueue runs with `scripts/enqueue.js` or `scripts/feed.js`.

The plugin is source-agnostic. Source adapters (for example SEC IAPD) are optional and separate.
