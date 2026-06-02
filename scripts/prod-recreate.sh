#!/usr/bin/env bash
# Atomic recreate for the jellybot prod container (canonical source).
#
# Operational copy lives at ~/docker/jellybot/recreate.sh. Keep this file
# and that one in sync; the operational copy is what humans/agents actually
# run, this one is the reviewable source of truth.
#
# Why this exists: running `docker compose pull` followed by `docker compose
# up -d` (or two consecutive up -d calls) can race when the previous
# container removal is still in-flight. Docker then assigns a transient
# `<short-id>_jellybot` name that compose never heals, and the
# protect-containers.sh canary fires CRITICAL: MISSING_FROM_DOCKER even
# though the bot is fine. One atomic compose invocation eliminates the
# overlap window entirely.
#
# Usage (on the prod host, not in Cursor Cloud):
#   bash ~/docker/jellybot/recreate.sh
#
# In normal ops you do not need this - Watchtower recreates jellybot when
# GHCR `:latest` advances. Use this when you've changed `.env` and need the
# new vars loaded right now.
set -euo pipefail

PROD_DIR="${PROD_DIR:-$HOME/docker/jellybot}"

if [ ! -f "$PROD_DIR/docker-compose.yml" ]; then
    echo "ERROR: $PROD_DIR/docker-compose.yml not found - this script is for prod hosts." >&2
    exit 2
fi

cd "$PROD_DIR"

echo "==> Pulling latest jellybot image"
docker compose pull jellybot

echo "==> Recreating jellybot atomically (single compose invocation; no race window)"
docker compose up -d --force-recreate --remove-orphans jellybot

echo "==> Waiting for healthy (max ~60s)"
for i in $(seq 1 30); do
    status=$(docker inspect --format='{{.State.Health.Status}}' jellybot 2>/dev/null || echo "missing")
    if [ "$status" = "healthy" ]; then
        echo "==> jellybot healthy"
        docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E 'NAMES|jellybot'
        exit 0
    fi
    sleep 2
done

echo "==> jellybot did not reach healthy in 60s - inspect: docker logs --tail 50 jellybot" >&2
exit 1
