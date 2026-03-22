#!/usr/bin/env node
/**
 * Print (and lightly probe) OpenClaw setup steps for this skill.
 * Idempotent: safe to run repeatedly. Does not write secrets unless you export them and use --apply-env.
 *
 * Usage:
 *   npm run setup:openclaw
 *   npm run setup:openclaw -- --apply-env    # run openclaw config set for BRAVE_API_KEY (requires openclaw CLI)
 *   npm run setup:openclaw -- --apply-cron   # DISABLED — TICK cron races with auto-resume (use TICK manually for recovery only)
 *
 * Env overrides (optional):
 *   ADVISOR_ORCH_AGENT_ID      default advisor-enrich
 *   ADVISOR_ORCH_SESSION_KEY   default session:advisor-orchestrator (printed in sessions_send / cron examples)
 *
 * The orchestrator workspace IS this skill's own directory (wherever the skill was installed).
 * No copy step is required: install to ~/.openclaw/workspace/skills/advisor-lead-gen/ once,
 * then point the advisor-enrich agent at that same path.
 */

const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/** Skill root = the directory this script lives in, one level up from scripts/. */
const ROOT = path.resolve(path.join(__dirname, ".."));

const DEFAULT_AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";

/**
 * The orchestrator workspace is the skill directory itself — wherever the user placed it.
 * Canonical: ~/.openclaw/workspace/skills/advisor-lead-gen
 * Override only via ADVISOR_ORCH_WORKSPACE if your layout differs.
 */
const DEFAULT_WORKSPACE = process.env.ADVISOR_ORCH_WORKSPACE || ROOT;

/** Stable session key for cron + control UI (override with ADVISOR_ORCH_SESSION_KEY). */
const DEFAULT_SESSION_KEY =
  process.env.ADVISOR_ORCH_SESSION_KEY || "session:advisor-orchestrator";

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
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    status: r.status,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const applyEnv = argv.includes("--apply-env");
  const applyCron = argv.includes("--apply-cron");

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  OpenClaw setup helper (advisor-lead-gen)                  ║");
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
    const list = runOpenclaw(["agents", "list"]);
    if (list.ok) {
      console.log("── openclaw agents list ──");
      console.log(list.stdout.trim() || "(no output)");
      console.log("");
    } else {
      console.log(
        "⚠️  openclaw agents list failed (gateway may be stopped or CLI misconfigured):",
      );
      console.log(list.stderr || list.stdout);
      console.log("");
    }
  }

  const ws = DEFAULT_WORKSPACE;

  console.log("── Orchestrator workspace (this skill directory) ──");
  console.log(`  ${ws}`);
  console.log(
    "  (Override with ADVISOR_ORCH_WORKSPACE if your layout differs)\n",
  );

  console.log(
    "── Create agent (idempotent: OpenClaw may error if id already exists — that is OK) ──",
  );
  console.log(
    `  openclaw agents add ${DEFAULT_AGENT_ID} \\\n` +
      `    --workspace "${ws}" \\\n` +
      `    --non-interactive \\\n` +
      `    --model anthropic/claude-haiku-4-5\n`,
  );

  console.log(
    "── Environment (gateway / agent process) — enrichment requires Brave ──",
  );
  console.log(
    '  openclaw config set env.BRAVE_API_KEY "<your-brave-search-api-key>"',
  );
  console.log("  # or, on newer CLI: openclaw env set BRAVE_API_KEY=<key>");
  console.log("  npm run env:help   # lists optional vars\n");

  if (applyEnv && process.env.BRAVE_API_KEY) {
    if (!ocPath) {
      console.log("❌ --apply-env requested but openclaw not on PATH.\n");
      process.exit(1);
    }
    console.log(
      "── Applying BRAVE_API_KEY from environment (openclaw config set) ──",
    );
    const r = runOpenclaw([
      "config",
      "set",
      "env.BRAVE_API_KEY",
      process.env.BRAVE_API_KEY,
    ]);
    if (r.ok) {
      console.log("OK  env.BRAVE_API_KEY set via openclaw config set\n");
    } else {
      console.log("❌ openclaw config set failed:");
      console.log(r.stderr || r.stdout);
      process.exit(1);
    }
  } else if (applyEnv) {
    console.log(
      "ℹ️  --apply-env: set BRAVE_API_KEY in the environment first, then re-run.\n",
    );
    process.exit(1);
  }

  const aid = DEFAULT_AGENT_ID;
  const sessionKey = DEFAULT_SESSION_KEY;
  console.log("── Default orchestrator session key (override ADVISOR_ORCH_SESSION_KEY) ──");
  console.log(`  ${sessionKey}\n`);
  console.log(
    "  Configure your OpenClaw agent/cron so turns run in this named persistent session",
  );
  console.log(
    "  (see OpenClaw docs: custom sessions session:… persist context across runs).\n",
  );

  console.log("── Enrichment (main agent / control UI / automation) ──");
  console.log(
    `  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "ENRICH:{...}", timeoutSeconds: 0 })`,
  );
  console.log(
    `  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "TICK", timeoutSeconds: 0 })`,
  );
  console.log(
    "  # Repeat TICK every 2–3s until sessions_history shows DONE:{...} (required for completion).",
  );
  console.log(
    '  # agentId is required — without it the gateway may use the wrong agent/workspace.\n',
  );

  console.log("── Verify (same session) ──");
  console.log(
    `  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "STATUS", timeoutSeconds: 0 })`,
  );
  console.log(
    `  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "ENV", timeoutSeconds: 0 })\n`,
  );

  console.log("── Dispatch cron (REQUIRED — without it nothing enriches) ──");
  console.log("  dispatch-cron.js is the only process that sends ENRICH to the advisor-enrich agent.");
  console.log("  enqueue-enrich.js only writes a DB row — the cron is what actually triggers the agent.");
  console.log("  Managed by PM2 — same commands on Docker, Linux, macOS, and Windows.\n");

  const pm2Path = which("pm2");
  if (!pm2Path) {
    console.log("  ① Install PM2 (one-time, global):  npm install -g pm2\n");
  } else {
    console.log(`  ✓ PM2 found: ${pm2Path}\n`);
  }

  console.log(`  ② Start the cron (from the skill directory):`);
  console.log(`     cd ${ROOT}`);
  console.log(`     pm2 start ecosystem.config.js`);
  console.log(`     pm2 save                         # persist across PM2 restarts\n`);
  console.log(`  ③ Boot persistence (Linux/macOS — run once, follow the printed command):`);
  console.log(`     pm2 startup`);
  console.log(`     pm2 save\n`);
  console.log(`  For Docker: run steps ①–② inside the container:`);
  console.log(`     docker exec <container> npm install -g pm2`);
  console.log(`     docker exec <container> sh -c "cd ${ROOT} && pm2 start ecosystem.config.js && pm2 save"\n`);
  console.log(`  Useful PM2 commands:`);
  console.log(`     npm run cron:status    # pm2 status advisor-cron`);
  console.log(`     npm run cron:logs      # pm2 logs advisor-cron`);
  console.log(`     npm run cron:restart   # pm2 restart advisor-cron`);
  console.log(`     npm run cron:stop      # pm2 stop advisor-cron\n`);
  console.log("  Queue an advisor (PM2-managed cron picks it up within 5s):");
  console.log("     node scripts/enqueue-enrich.js --sec-id <SEC_ID>");
  console.log("     npm run enqueue -- --sec-id <SEC_ID>\n");
  console.log("  ⚠️  DO NOT add a TICK cron job — TICK races with auto-resume and corrupts saves.");
  console.log("  TICK is a manual recovery command only (use if an enrichment is visibly stuck after >5 min).");
  console.log(`  sessions_send({ sessionKey: "${sessionKey}", agentId: "${aid}", message: "TICK", timeoutSeconds: 60 })\n`);

  if (applyCron) {
    console.log("❌ --apply-cron is disabled — use PM2 + ecosystem.config.js instead (see above).");
    process.exit(1);
  }

  console.log(
    "More detail: references/INSTALL_AUTOMATION.md, references/OPENCLAW_RUNTIME.md\n",
  );
}

main();
