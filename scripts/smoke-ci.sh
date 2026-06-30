#!/usr/bin/env bash
# CI: build JellyBot-Dev, preflight Jellyfin, then Discord user-token smoke (required).
# Self-hosted runner — reads ~/coding/jellybot-dev/.env + discord.py-self/.env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export HEALTH_PORT="${JELLYBOT_SMOKE_HOST_PORT:-8093}"
export SUBTITLE_INDEX_ON_STARTUP=off
export JELLYBOT_SMOKE_HEALTH_URL="${JELLYBOT_SMOKE_HEALTH_URL:-http://127.0.0.1:${HEALTH_PORT}/healthz}"
export JELLYBOT_SMOKE_LOG_CMD="${JELLYBOT_SMOKE_LOG_CMD:-docker logs jellybot-dev}"
export DISCORD_PY_SELF_ROOT="${DISCORD_PY_SELF_ROOT:-$HOME/coding/discord.py-self}"

cleanup() {
  if [ "${JELLYBOT_SMOKE_LEAVE_UP:-0}" != "1" ]; then
    docker compose --profile app stop jellybot >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "smoke-ci: building JellyBot-Dev (host :${HEALTH_PORT})"
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
