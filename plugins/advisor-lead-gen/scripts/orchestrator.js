#!/usr/bin/env node
/**
 * REMOVED — this file is no longer the orchestrator implementation.
 *
 * The canonical orchestrator is IDENTITY.md (the system prompt for the
 * advisor-enrich agent). Queue advisors with enqueue-enrich.js; the cron
 * process dispatch-cron.js sends ENRICH to the agent automatically.
 */
console.error(
  "scripts/orchestrator.js is not the active orchestrator.\n" +
  "  Queue an advisor : node scripts/enqueue-enrich.js --sec-id <ID>\n" +
  "  Start the cron   : npm run cron\n" +
  "  See orchestrator : IDENTITY.md"
);
process.exit(1);
