#!/usr/bin/env bash
# CI: build PR image, ephemeral JellyBot-Dev on self-hosted runner, Discord user-token smoke.
# Does NOT clobber the long-lived jellybot-dev on :8093 — uses :8094 + jellybot-smoke-<run>.
# Host secrets: ~/coding/jellybot-dev/.env + discord.py-self/.env

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST_ENV="${JELLYBOT_ENV_FILE:-$HOME/coding/jellybot-dev/.env}"
if [ ! -f .env ]; then
  if [ ! -f "$HOST_ENV" ]; then
    echo "smoke-ci: missing ./.env and ${HOST_ENV} — host dev checkout must exist on the runner" >&2
    exit 1
  fi
  ln -sf "$HOST_ENV" .env
fi

SMOKE_ID="${GITHUB_RUN_ID:-local$$}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-jellybot-smoke-${SMOKE_ID}}"
export JELLYBOT_CONTAINER_NAME="${JELLYBOT_CONTAINER_NAME:-jellybot-smoke-${SMOKE_ID}}"
export JELLYBOT_RESTART_POLICY=no
export HEALTH_PORT="${JELLYBOT_SMOKE_HOST_PORT:-8094}"
export SUBTITLE_INDEX_ON_STARTUP=off
export JELLYBOT_DATA_HOST_DIR="${JELLYBOT_DATA_HOST_DIR:-/home/heavygee/docker/jellybot/data}"
export JELLYBOT_SMOKE_HEALTH_URL="${JELLYBOT_SMOKE_HEALTH_URL:-http://127.0.0.1:${HEALTH_PORT}/healthz}"
export JELLYBOT_SMOKE_LOG_CMD="${JELLYBOT_SMOKE_LOG_CMD:-docker logs ${JELLYBOT_CONTAINER_NAME}}"
export DISCORD_PY_SELF_ROOT="${DISCORD_PY_SELF_ROOT:-$HOME/coding/discord.py-self}"

cleanup() {
  if [ "${JELLYBOT_SMOKE_LEAVE_UP:-0}" != "1" ]; then
    docker compose --profile app down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "smoke-ci: ephemeral ${JELLYBOT_CONTAINER_NAME} on host :${HEALTH_PORT} (project ${COMPOSE_PROJECT_NAME})"
docker compose --profile app build jellybot
SUBTITLE_INDEX_ON_STARTUP=off docker compose --profile app up -d --force-recreate jellybot

echo "smoke-ci: preflight (Jellyfin + subtitle index in container — not Discord smoke)"
docker compose --profile app exec -T jellybot bun run src/cli/smoke-live.ts

echo "smoke-ci: Discord smoke (user token → slash autocomplete in Bottitesto)"
python3 - <<'PY'
import os, sys
sys.path.insert(0, "scripts")
from discord_smoke_support import assert_health_responsive, smoke_health_url
assert_health_responsive(smoke_health_url(), timeout_sec=2.0)
print("[OK] dev bot health responsive before Discord smoke")
PY
python3 scripts/smoke-dev-bot.py --skip-health

echo "smoke-ci: passed"
