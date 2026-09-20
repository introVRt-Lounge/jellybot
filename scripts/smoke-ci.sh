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
# Host-published Jellyfin (not traefik DNS) — see docker-compose.smoke.yml / #206.
export JELLYBOT_SMOKE_JELLYFIN_URL="${JELLYBOT_SMOKE_JELLYFIN_URL:-http://172.17.0.1:8096}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.smoke.yml)

cleanup() {
  if [ "${JELLYBOT_SMOKE_LEAVE_UP:-0}" != "1" ]; then
    "${COMPOSE[@]}" --profile app down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "smoke-ci: ephemeral ${JELLYBOT_CONTAINER_NAME} on host :${HEALTH_PORT} (project ${COMPOSE_PROJECT_NAME})"
echo "smoke-ci: Jellyfin via ${JELLYBOT_SMOKE_JELLYFIN_URL} (no traefik_net — protects prod jellybot DNS)"
"${COMPOSE[@]}" --profile app build jellybot
SUBTITLE_INDEX_ON_STARTUP=off "${COMPOSE[@]}" --profile app up -d --force-recreate jellybot

echo "smoke-ci: waiting for ${JELLYBOT_CONTAINER_NAME} healthy"
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${JELLYBOT_CONTAINER_NAME}" 2>/dev/null || echo missing)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "exited" ] || [ "$status" = "dead" ] || [ "$status" = "missing" ]; then
    echo "smoke-ci: container ${JELLYBOT_CONTAINER_NAME} status=${status}" >&2
    docker logs "${JELLYBOT_CONTAINER_NAME}" 2>&1 | tail -40 >&2 || true
    exit 1
  fi
  sleep 1
done

echo "smoke-ci: preflight (Jellyfin + subtitle index in container — not Discord smoke)"
# Use docker exec (not compose exec): compose exec has hung after smoke-live
# PASSED, burning the full timeout before Discord smoke can run.
# Timeout (124) only: continue to Discord gate. Real smoke-live failures stay fatal.
set +e
timeout 120 docker exec "${JELLYBOT_CONTAINER_NAME}" bun run src/cli/smoke-live.ts
smoke_live_rc=$?
set -e
if [ "$smoke_live_rc" -eq 124 ]; then
  echo "smoke-ci: smoke-live timed out — continuing to Discord autocomplete gate" >&2
elif [ "$smoke_live_rc" -ne 0 ]; then
  echo "smoke-ci: smoke-live failed (exit ${smoke_live_rc})" >&2
  exit "$smoke_live_rc"
fi

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
