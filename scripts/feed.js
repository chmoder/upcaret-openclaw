#!/usr/bin/env node
process.env._ENRICH_SCRIPT = "feed.js";
require("./_run-enrichment-script.cjs");
