#!/usr/bin/env bash
# Stop OpenClaw Docker and remove local config so you can run setup from a clean slate.
# Destructive: renames ~/.openclaw to a timestamped backup and removes the repo .env
# (gateway token and compose env). Review before running.
#
# Usage:
#   I_UNDERSTAND_DELETE_OPENCLAW_CONFIG=1 ./scripts/openclaw-docker-reset.sh
#   ./scripts/openclaw-docker-reset.sh --yes
#
# Optional:
#   OPENCLAW_REPO=~/development/openclaw  (default)

set -euo pipefail

if [[ "${I_UNDERSTAND_DELETE_OPENCLAW_CONFIG:-}" != "1" && "${1:-}" != "--yes" ]]; then
  echo "This will:"
  echo "  - docker compose down (in OPENCLAW_REPO)"
  echo "  - move ~/.openclaw to ~/.openclaw.bak.<timestamp>"
  echo "  - remove <repo>/.env and optional docker-compose.extra.yml / docker-compose.sandbox.yml"
  echo ""
  echo "Re-run with:"
  echo "  I_UNDERSTAND_DELETE_OPENCLAW_CONFIG=1 $0"
  echo "  or: $0 --yes"
  exit 1
fi

REPO="${OPENCLAW_REPO:-$HOME/development/openclaw}"

if [[ -d "$REPO" && -f "$REPO/docker-compose.yml" ]]; then
  echo "==> Stopping containers in $REPO"
  (cd "$REPO" && docker compose down --remove-orphans 2>/dev/null) || true
  # If compose project name/volumes drifted, force-stop any leftover openclaw containers
  for id in $(docker ps -q --filter "name=openclaw" 2>/dev/null); do
    docker stop "$id" 2>/dev/null || true
  done
  rm -f "$REPO/docker-compose.extra.yml" "$REPO/docker-compose.sandbox.yml" 2>/dev/null || true
  if [[ -f "$REPO/.env" ]]; then
    echo "==> Removing $REPO/.env"
    rm -f "$REPO/.env"
  fi
else
  echo "==> No compose project at $REPO (skipping docker compose down)"
fi

if [[ -d "$HOME/.openclaw" ]]; then
  BAK="$HOME/.openclaw.bak.$(date +%Y%m%d%H%M%S)"
  echo "==> Moving $HOME/.openclaw -> $BAK"
  mv "$HOME/.openclaw" "$BAK"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo ""
echo "==> Reset complete."
echo "    Next: cd \"$ROOT\" && ./scripts/openclaw-docker-setup.sh"
echo "    Or:  cd \"$REPO\" && export OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest && ./scripts/docker/setup.sh"
echo ""
