#!/usr/bin/env node
process.env._ENRICH_SCRIPT = "save-profiles.js";
require("./_run-enrichment-script.cjs");
