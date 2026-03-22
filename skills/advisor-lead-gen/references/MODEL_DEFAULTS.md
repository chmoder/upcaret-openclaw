# Model defaults (this product)

**Default model:** **`anthropic/claude-haiku-4-5`** (Claude Haiku 4.5).

Use this for:

- **`openclaw agents add … --model anthropic/claude-haiku-4-5`** (see `npm run setup:openclaw`)
- **`agents.defaults.model.primary`** in **`openclaw.json`** when configuring the gateway

Do **not** standardize on **Opus** for this skill’s documented install — if an environment still has **`claude-opus-*`** as the default, change it to **`anthropic/claude-haiku-4-5`** unless you have a specific reason to keep a heavier model.

## Config vs. an existing chat session

Changing **`agents.defaults.model.primary`** (or the Control UI default) does **not** retroactively rewrite an **already-open** session. Each session stores its active model in **`~/.openclaw/agents/<agentId>/sessions/`** (e.g. a `model_change` line in the session `.jsonl` and metadata in **`sessions.json`**). If the **picker** shows Haiku but **`ctx`** in the transcript still says **`claude-opus-*`**, that session was created or switched under Opus — **start a new chat**, or **change the model in the UI** so a new `model_change` is applied for that thread, or align the on-disk session files with Haiku (advanced).

Per-agent overrides (e.g. orchestrator vs main) follow your OpenClaw version’s config schema; the **baseline** for copy-paste setup in this repo is always Haiku 4.5.
