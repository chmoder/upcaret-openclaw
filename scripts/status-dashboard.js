#!/usr/bin/env node
process.env._ENRICH_SCRIPT = "status-dashboard.js";
require("./_run-enrichment-script.cjs");
