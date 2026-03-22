# OpenClaw via Docker (quick test of advisor-lead-gen)

Uses the [official Docker flow](https://docs.openclaw.ai/install/docker): `scripts/docker/setup.sh` from the `openclaw/openclaw` repo, with a **prebuilt image** so you skip local builds.

## Prerequisites

- Docker Desktop (or Docker Engine) + Compose v2 on macOS
- ~2 GB free RAM for pulls/builds

## One command (from this repo)

```bash
chmod +x scripts/openclaw-docker-setup.sh
./scripts/openclaw-docker-setup.sh
```

This clones `openclaw` to `~/development/openclaw` if needed, sets `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest`, and runs `./scripts/docker/setup.sh`.

**Onboarding is interactive** (API keys, etc.) — run the script in a real terminal, not headless CI.

## Manual (same as upstream docs)

```bash
git clone --depth 1 https://github.com/openclaw/openclaw.git ~/development/openclaw
cd ~/development/openclaw
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
./scripts/docker/setup.sh
```

## After the gateway is up

- Control UI / chat: `http://127.0.0.1:18789/` — **WebSocket** `ws://127.0.0.1:18789`, **Gateway Token** = value of `OPENCLAW_GATEWAY_TOKEN` in **`~/development/openclaw/.env`** (must match what Docker passes to the container; if you re-ran setup, sync `~/.openclaw/openclaw.json` `gateway.auth.token` to that same value).
- Health: `curl -fsS http://127.0.0.1:18789/healthz` → **200**

### Continue: test advisor-lead-gen

1. **Rsync the skill contents** into **`~/.openclaw/workspace/skills/advisor-lead-gen/`** (so **`package.json`** is at that folder’s root; see **`skills/advisor-lead-gen/references/SETUP_WIZARD.md`**), then **`cd` there and `npm run bootstrap`**.
2. Merge or add the **`advisor-enrich`** agent from **`npm run setup:openclaw`** output into **`~/.openclaw/openclaw.json`** (or use Control UI if your version supports it), pointing **`workspace`** at **`…/workspace/skills/advisor-lead-gen`**.
3. Enrichment: **`sessions_send`** / cron with **`agentId: "advisor-enrich"`** and **`sessionTarget`**, messages **`ENRICH` + `TICK`** — see **`skills/advisor-lead-gen/references/OPENCLAW_RUNTIME.md`**.

Docker bind-mounts are described in the [OpenClaw Docker doc](https://docs.openclaw.ai/install/docker); config on disk is under **`~/.openclaw`**.

## Optional: pull the image first (faster first run)

```bash
docker pull ghcr.io/openclaw/openclaw:latest
```

## Start over from scratch (clean reset)

Use this if the gateway **restart-loops**, setup **failed halfway**, or you want a **blank** local OpenClaw (Docker bind-mount under `~/.openclaw`).

**From this repo:**

```bash
I_UNDERSTAND_DELETE_OPENCLAW_CONFIG=1 ./scripts/openclaw-docker-reset.sh
./scripts/openclaw-docker-setup.sh
```

The reset script **`docker compose down`**, **removes `~/development/openclaw/.env`**, and **renames `~/.openclaw`** to `~/.openclaw.bak.<timestamp>` (your old config is not deleted, only moved).

**Manual equivalent:**

```bash
cd ~/development/openclaw
docker compose down --remove-orphans
rm -f .env
mv ~/.openclaw ~/.openclaw.bak.manual
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
./scripts/docker/setup.sh
```

### Why the gateway sometimes loops on “Missing config”

The official `setup.sh` creates `~/.openclaw` dirs, then runs **`docker compose run`** steps. If **`openclaw.json` never gets written** (onboarding didn’t finish), the **gateway** container starts with **`restart: unless-stopped`** and exits with *Missing config*, which breaks **later** `compose run` steps that share the gateway network. A full reset + **complete interactive onboarding** fixes it.

After a successful run, you should have **`~/.openclaw/openclaw.json`** with **`gateway.mode": "local"`** before relying on the gateway.

### Setup script stops after onboarding with “cannot join network namespace … is restarting”

The gateway can crash-loop **after** onboarding because **`gateway.bind: "lan"`** requires **`gateway.controlUi.allowedOrigins`** for the Control UI. If the official `setup.sh` exits before it runs the step that sets allowlist, the gateway keeps restarting and `docker compose run openclaw-cli …` fails.

**Fix:** add allowlist + restart (adjust port if yours is not `18789`):

```json
"gateway": {
  "controlUi": {
    "allowedOrigins": [
      "http://127.0.0.1:18789",
      "http://localhost:18789"
    ]
  }
}
```

Merge that into **`~/.openclaw/openclaw.json`** under the existing **`gateway`** object, then:

```bash
cd ~/development/openclaw
docker compose restart openclaw-gateway
curl -fsS http://127.0.0.1:18789/healthz
```

You should see **`200`** and **`docker ps`** should show the gateway **healthy**.

### Dashboard shows “pairing required” after pasting the token

Over plain **HTTP** (`http://127.0.0.1:18789`), the Control UI may require **device pairing** unless you relax local dev checks. Add under **`gateway.controlUi`** (next to **`allowedOrigins`**):

```json
"allowInsecureAuth": true,
"dangerouslyDisableDeviceAuth": true
```

Then **`docker compose restart openclaw-gateway`**. **Only use these on trusted localhost** — they weaken Control UI device identity checks.

**Alternative (stricter):** keep pairing on and approve the browser:

```bash
cd ~/development/openclaw
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```
