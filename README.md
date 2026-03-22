# UpCaret OpenClaw skills

This repository holds **[AgentSkills](https://agentskills.io)-compatible** OpenClaw skill bundles for UpCaret. Each skill lives in its own directory under `skills/` so you can version, test, and publish them independently.

## Layout

```text
skills/
  advisor-lead-gen/     # SEC IAPD download + orchestrated enrichment
  <future-skill>/       # add new skills as sibling folders
```

Each skill folder is self-contained: `SKILL.md`, `package.json`, `scripts/`, `agents/`, `references/`, etc.

## Drop into any OpenClaw

1. Copy **`skills/advisor-lead-gen/`** *into* **`~/.openclaw/workspace/skills/advisor-lead-gen/`** so the skill files sit at the **root** of that directory (see **`skills/advisor-lead-gen/references/SETUP_WIZARD.md`**).
2. In OpenClaw chat, say **“set up the lead gen skill”** — the agent follows **`skills/advisor-lead-gen/references/SETUP_WIZARD.md`** (chat-first: agent runs commands via tools when possible; user is not expected to use Terminal first).
3. If you’re not using chat, on the host: **`cd ~/.openclaw/workspace/skills/advisor-lead-gen`**, **`npm run bootstrap`**, **`npm run setup:openclaw`**.

## Prerequisites

- **Node.js** 18+ (see each skill’s `package.json` `engines` if stricter)
- **sqlite3** CLI on `PATH` (used by bootstrap / DB scripts)
- For enrichment: **`BRAVE_API_KEY`** (and optional keys per skill docs)

## Working on a skill

```bash
cd skills/advisor-lead-gen
npm install   # only if you add dependencies; currently empty
npm test
npm run bootstrap
```

OpenClaw gateway setup is documented inside each skill (`npm run setup:openclaw`).

## Publishing

- **ClawHub:** from a clean copy of a skill folder (no `advisors.db`, no secrets), use the [ClawHub CLI](https://docs.openclaw.ai/tools/clawhub): `clawhub publish ./skills/<name> ...`
- **Private B2B:** distribute a zip or grant access to this repo / a release artifact—do not rely on ClawHub for private packages.

## License

Per-skill licenses are declared in each skill’s `package.json` (default MIT unless noted otherwise).
