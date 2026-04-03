#!/usr/bin/env node
process.env._ENRICH_SCRIPT = "enqueue.js";
require("./_run-enrichment-script.cjs");
