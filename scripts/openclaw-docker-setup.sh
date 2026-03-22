#!/usr/bin/env bash
# Run OpenClaw's documented Docker install (https://docs.openclaw.ai/install/docker).
# Prereq: Docker Desktop running on macOS.
#
# Usage:
#   chmod +x scripts/openclaw-docker-setup.sh
#   ./scripts/openclaw-docker-setup.sh
#
# Optional:
#   OPENCLAW_REPO=/path/to/openclaw   (default: ~/development/openclaw)
#   OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest  (default: prebuilt image, skips local build)

set -euo pipefail

ROOT="${OPENCLAW_REPO:-$HOME/development/openclaw}"

if [[ ! -f "$ROOT/scripts/docker/setup.sh" ]]; then
  echo "==> Cloning OpenClaw (shallow) into $ROOT"
  mkdir -p "$(dirname "$ROOT")"
  git clone --depth 1 https://github.com/openclaw/openclaw.git "$ROOT"
fi

export OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"

echo "==> Using image: $OPENCLAW_IMAGE"
echo "==> Running official setup: $ROOT/scripts/docker/setup.sh"
echo "    (Onboarding is interactive — complete prompts in this terminal.)"
echo ""

cd "$ROOT"
exec ./scripts/docker/setup.sh
