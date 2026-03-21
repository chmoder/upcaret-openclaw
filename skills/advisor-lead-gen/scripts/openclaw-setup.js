#!/usr/bin/env node
/**
 * Print (and lightly probe) OpenClaw setup steps for this skill.
 * Idempotent: safe to run repeatedly. Does not write secrets unless you export them and use --apply-env.
 *
 * Usage:
 *   npm run setup:openclaw
 *   npm run setup:openclaw -- --apply-env   # if BRAVE_API_KEY is set in environment, run openclaw config set (requires openclaw CLI)
 */

const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(path.join(__dirname, ".."));
const DEFAULT_AGENT_ID = process.env.ADVISOR_ORCH_AGENT_ID || "advisor-enrich";
const DEFAULT_WORKSPACE =
  process.env.ADVISOR_ORCH_WORKSPACE ||
  path.join(os.homedir(), ".openclaw", "workspace-advisor-enrich");

function which(cmd) {
  const bin = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(bin, [cmd], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null;
}

function runOpenclaw(args, { json = false } = {}) {
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
  const skillRoot = ROOT;

  console.log("Suggested workspace (override with ADVISOR_ORCH_WORKSPACE):");
  console.log(`  ${ws}\n`);

  console.log(
    "── Copy skill into orchestrator workspace (idempotent if you use rsync or overwrite) ──",
  );
  console.log(`  mkdir -p "${ws}"`);
  console.log(`  cp -R "${skillRoot}/." "${ws}/"\n`);

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

  console.log("── Bootstrap DB inside workspace (after copy) ──");
  console.log(`  cd "${ws}" && npm run bootstrap\n`);

  console.log("── Enrichment (from main agent / control UI) ──");
  console.log(
    '  sessions_send({ sessionKey: "<orchestrator-session-key>", message: "ENRICH:{...}", timeoutSeconds: 0 })',
  );
  console.log(
    "  # Use sessions_list to discover the real sessionKey for your orchestrator agent.\n",
  );

  console.log(
    "More detail: references/INSTALL_AUTOMATION.md, references/OPENCLAW_RUNTIME.md\n",
  );
}

main();
