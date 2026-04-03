#!/usr/bin/env node
process.env._ENRICH_SCRIPT = "next-profile.js";
require("./_run-enrichment-script.cjs");
