#!/usr/bin/env node
process.env._ENRICH_SCRIPT = "reset-queue.js";
require("./_run-enrichment-script.cjs");
