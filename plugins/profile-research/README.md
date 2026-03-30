# profile-research (OpenClaw plugin)

General-purpose profile research plugin for the standalone `enrichment` core.

This plugin handles creative profile discovery requests, including:

- individual lookups
- groups by trade, firm, or location
- event speaker/attendee profile collection
- "friends of"/network discovery prompts

## Dependency

Install and enable `enrichment` first.

## ACP / `acpx` (optional)

This plugin does **not** install the ACP backend. If something delegates with `sessions_spawn` and **`runtime: "acp"`**, install **`@openclaw/acpx`** on the gateway host, enable it in `openclaw.json`, add the `acp` settings, restart the gateway, and run `/acp doctor`. Normal **`profile-researcher`** use via **subagent** (or `openclaw agent --agent profile-researcher`) does not require ACP.

## Install

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw plugins install profile-research
openclaw plugins enable profile-research
openclaw gateway restart
```

On gateway startup, this plugin auto-configures an OpenClaw agent entry with id `profile-researcher`.

## Usage

Run with a direct agent prompt:

```bash
openclaw agent --agent profile-researcher --message "Find certified financial planners in Austin, TX"
```

The agent saves discovered profiles through `scripts/save-profiles.js`, which delegates to enrichment's public save CLI (`enrichment/scripts/save-profiles.js`) for a single write policy. It writes `profiles` only (no findings writes).
