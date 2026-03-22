#!/usr/bin/env node
/**
 * OpenClaw setup helper for the advisor-lead-gen plugin.
 * Idempotent: safe to run repeatedly. Does not write secrets unless --apply-env is passed.
 *
 * Usage:
 *   npm run setup:openclaw
 *   npm run setup:openclaw -- --apply-env    # run openclaw config set for BRAVE_API_KEY (requires openclaw CLI)
 *
 * Env overrides (optional):
 *   ADVISOR_ORCH_AGENT_ID      default advisor-enrich
 *   ADVISOR_ORCH_SESSION_KEY   default session:advisor-orchestrator
 */

const path = require("path");
const { spawnSync } = require("child_process");

/** Plugin root = the directory this script lives in, one level up from scripts/. */
const ROOT = path.resolve(path.join(__dirname, ".."));

const DEFAULT_AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
const DEFAULT_SESSION_KEY =
  process.env.ADVISOR_ORCH_SESSION_KEY || "session:advisor-orchestrator";

/** Canonical plugin install location (where OpenClaw places it after `plugins install`). */
const PLUGIN_PATH = "~/.openclaw/extensions/advisor-lead-gen";

function which(cmd) {
  const bin = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(bin, [cmd], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null;
}

function runOpenclaw(args) {
  const oc = which("openclaw");
  if (!oc) return { ok: false, err: "openclaw CLI not on PATH" };
  const r = spawnSync(oc, args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    status: r.status,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const applyEnv = argv.includes("--apply-env");

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  OpenClaw setup helper (advisor-lead-gen plugin)           ║");
  console.log(
    "╚════════════════════════════════════════════════════════════╝\n",
  );

  const ocPath = which("openclaw");
  if (!ocPath) {
    console.log("ℹ️  openclaw CLI not found on PATH.");
    console.log(
      "   Install OpenClaw and ensure `openclaw` is available, then re-run this script.\n",
    );
  } else {
    console.log(`OK  openclaw → ${ocPath}\n`);
  }

  // ── Step 1: Plugin install + enable ──────────────────────────────────────
  console.log(
    "── Step 1: Install plugin (handles skill discovery + PM2 auto-start on every restart) ──",
  );

  if (ocPath) {
    console.log("  Attempting: openclaw plugins install -l ...");
    const installResult = runOpenclaw(["plugins", "install", "-l", ROOT]);
    if (installResult.ok) {
      console.log("  OK  plugins install succeeded.\n");
    } else {
      console.log(
        `  ⚠️  plugins install failed (may already be installed — that is OK):`,
      );
      console.log(`      ${installResult.stderr || installResult.stdout}`);
      console.log(
        "  Run manually if needed: openclaw plugins install -l " + ROOT + "\n",
      );
    }

    console.log("  Attempting: openclaw plugins enable advisor-lead-gen ...");
    const enableResult = runOpenclaw(["plugins", "enable", "advisor-lead-gen"]);
    if (enableResult.ok) {
      console.log("  OK  plugins enable succeeded.\n");
    } else {
      console.log(
        `  ⚠️  plugins enable failed (may already be enabled — that is OK):`,
      );
      console.log(`      ${enableResult.stderr || enableResult.stdout}`);
      console.log(
        "  Run manually if needed: openclaw plugins enable advisor-lead-gen\n",
      );
    }
  } else {
    console.log("  (skipping auto-install — openclaw CLI not on PATH)\n");
    console.log("  Run manually:");
    console.log(`    openclaw plugins install -l ${ROOT}`);
    console.log("    openclaw plugins enable advisor-lead-gen\n");
    console.log("  From ClawHub (when published):");
    console.log("    openclaw plugins install advisor-lead-gen\n");
  }

  // ── Step 2: BRAVE_API_KEY ────────────────────────────────────────────────
  console.log(
    "── Step 2: Set BRAVE_API_KEY (required for enrichment) ──",
  );
  console.log(
    '  openclaw config set env.BRAVE_API_KEY "<your-brave-search-api-key>"',
  );
  console.log("  npm run env:help   # lists all optional vars\n");

  if (applyEnv && process.env.BRAVE_API_KEY) {
    if (!ocPath) {
      console.log("❌ --apply-env requested but openclaw not on PATH.\n");
      process.exit(1);
    }
    console.log(
      "  Applying BRAVE_API_KEY from environment (openclaw config set) ...",
    );
    const r = runOpenclaw([
      "config",
      "set",
      "env.BRAVE_API_KEY",
      process.env.BRAVE_API_KEY,
    ]);
    if (r.ok) {
      console.log("  OK  env.BRAVE_API_KEY set via openclaw config set\n");
    } else {
      console.log("  ❌ openclaw config set failed:");
      console.log(`     ${r.stderr || r.stdout}`);
      process.exit(1);
    }
  } else if (applyEnv) {
    console.log(
      "  ℹ️  --apply-env: export BRAVE_API_KEY in your shell first, then re-run.\n",
    );
    process.exit(1);
  }

  // ── Step 3: Create orchestrator agent ───────────────────────────────────
  const aid = DEFAULT_AGENT_ID;
  console.log(
    "── Step 3: Create orchestrator agent (idempotent — error if already exists is OK) ──",
  );
  console.log(
    `  openclaw agents add ${aid} \\\n` +
      `    --workspace "${PLUGIN_PATH}"\n`,
  );
  console.log("  Via Docker (add -T to disable TTY):");
  console.log(
    `    docker compose run --rm -T openclaw-cli agents add ${aid} \\\n` +
      `      --workspace "/home/node/.openclaw/extensions/advisor-lead-gen"\n`,
  );

  // ── Step 4: Restart gateway ──────────────────────────────────────────────
  console.log(
    "── Step 4: Restart gateway — activates plugin, auto-starts PM2 cron ──",
  );
  console.log("  openclaw gateway restart\n");
  console.log(
    "  The plugin's gateway:startup hook fires on every restart and:",
  );
  console.log("    • validates Node version, required files, BRAVE_API_KEY");
  console.log("    • initialises DB schema (idempotent)");
  console.log("    • starts advisor-cron via PM2 automatically\n");
  console.log(
    "  No manual PM2 steps needed — the plugin handles it on every boot.\n",
  );

  // ── Session / enrichment reference ──────────────────────────────────────
  const sessionKey = DEFAULT_SESSION_KEY;
  console.log(
    "── Enrichment session reference (once gateway + agent are ready) ──",
  );
  console.log(`  Session key: ${sessionKey}`);
  console.log(
    `  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "ENRICH:{...}", timeoutSeconds: 0 })`,
  );
  console.log(
    `  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "STATUS", timeoutSeconds: 0 })\n`,
  );
  console.log(
    "  ⚠️  DO NOT add a TICK cron job — TICK races with auto-resume and corrupts saves.",
  );
  console.log(
    "  TICK is a manual recovery command only (use if an enrichment is visibly stuck after >5 min).\n",
  );

  console.log(
    "More detail: references/INSTALL_AUTOMATION.md, references/OPENCLAW_RUNTIME.md\n",
  );
}

main();
