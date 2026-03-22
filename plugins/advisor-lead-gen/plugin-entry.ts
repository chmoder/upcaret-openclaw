import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export default definePluginEntry({
  id: "advisor-lead-gen",
  name: "SEC IAPD Advisor Lead Gen",
  description: "Manages advisor-cron and validates setup on gateway startup",
  register(api) {
    // api.resolvePath is the correct way to get the plugin root under jiti.
    // import.meta.url resolves to jiti's own directory, not the plugin directory.
    const ROOT = api.resolvePath(".");
    const log = api.logger;

    api.registerHook("gateway:startup", async () => {
      const errors: string[] = [];

      // 1. Node version — node:sqlite requires 22.5+
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 5)) {
        errors.push(
          `Node ${process.versions.node} is too old — requires 22.5+. Upgrade: https://nodejs.org`,
        );
      }

      // 2. Required files — spot-check key files to catch corrupt/partial installs
      for (const rel of [
        "IDENTITY.md",
        "scripts/dispatch-cron.js",
        "ecosystem.config.js",
      ]) {
        if (!existsSync(join(ROOT, rel))) {
          errors.push(`Missing ${rel} — reinstall the plugin.`);
        }
      }

      // 3. BRAVE_API_KEY — required for enrichment; SEC download-only works without it
      if (!process.env.BRAVE_API_KEY) {
        errors.push(
          'BRAVE_API_KEY not set. Run: openclaw config set env.BRAVE_API_KEY "<key>"',
        );
      }

      // 4. DB schema — idempotent, safe to run on every boot
      try {
        const { initSchema } = require(join(ROOT, "scripts/db-init.js"));
        const { openDb } = require(join(ROOT, "scripts/db.js"));
        const db = openDb(join(ROOT, "advisors.db"));
        try {
          initSchema(db);
        } finally {
          db.close();
        }
      } catch (e: any) {
        errors.push(
          `DB init failed: ${e.message} — run: cd ${ROOT} && npm run bootstrap`,
        );
      }

      // 5. PM2 + advisor-cron — auto-start if not already running
      const pm2Check = spawnSync("pm2", ["--version"], { encoding: "utf8" });
      if (pm2Check.status !== 0) {
        errors.push(
          "pm2 not found — run: npm install -g pm2  (then restart gateway)",
        );
      } else {
        const jlist = spawnSync("pm2", ["jlist"], { encoding: "utf8" });
        let online = false;
        try {
          const list: Array<{ name: string; pm2_env?: { status?: string } }> =
            JSON.parse(jlist.stdout || "[]");
          online = list.some(
            (p) => p.name === "advisor-cron" && p.pm2_env?.status === "online",
          );
        } catch {}

        if (!online) {
          const eco = join(ROOT, "ecosystem.config.js");
          if (existsSync(eco)) {
            spawnSync("pm2", ["start", eco], { stdio: "ignore" });
            spawnSync("pm2", ["save", "--force"], { stdio: "ignore" });
            log.info("advisor-cron started via PM2.");
          } else {
            errors.push("ecosystem.config.js missing — reinstall the plugin.");
          }
        }
      }

      // Report — collected errors so the user sees everything at once
      if (errors.length > 0) {
        log.error("SETUP ERRORS — fix these and restart the gateway:");
        errors.forEach((e, i) => log.error(`  ${i + 1}. ${e}`));
        log.error(`For full env help: cd ${ROOT} && npm run env:help`);
      } else {
        log.info("All checks passed. advisor-cron is running.");
      }
    });
  },
});
