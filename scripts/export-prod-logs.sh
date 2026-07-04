#!/usr/bin/env bash
# Snapshot prod jellybot logs for OpenACP-jelly (read-only at /prod-logs).
#
# Isolation contract: OpenACP never gets docker.sock. This host cron is the
# only bridge from `docker logs` / healthz into files the bot can read.
#
# Writes:
#   jellybot.log          — rolling full stdout/stderr (append + rotate)
#   jellybot.signals.log  — errors + user-interaction events only
#   healthz.json          — live GET /healthz snapshot
#   export.cron.log       — this script's own stderr/stdout (via cron redirect)
#
# Operational copy (what cron runs): ~/docker/jellybot/export-prod-logs.sh
# Keep that file in sync with this script.
#
# Cron (host):
#   * * * * * /home/heavygee/docker/jellybot/export-prod-logs.sh >> /home/heavygee/docker/jellybot/logs/export.cron.log 2>&1

set -euo pipefail

DOCKER="${DOCKER_BIN:-/usr/bin/docker}"
CURL="${CURL_BIN:-/usr/bin/curl}"
CONTAINER="${JELLYBOT_CONTAINER:-jellybot}"
LOG_DIR="${JELLYBOT_PROD_LOG_DIR:-${HOME}/docker/jellybot/logs}"
OUT="${JELLYBOT_PROD_LOG_FILE:-${LOG_DIR}/jellybot.log}"
SIGNALS="${JELLYBOT_PROD_SIGNALS_FILE:-${LOG_DIR}/jellybot.signals.log}"
HEALTHZ_OUT="${JELLYBOT_PROD_HEALTHZ_FILE:-${LOG_DIR}/healthz.json}"
STATE_DIR="${JELLYBOT_PROD_LOG_STATE:-${LOG_DIR}/.export-state}"
SINCE_FILE="${STATE_DIR}/last-since"
# Max bytes for rolling full log / signals (default 20 MiB / 5 MiB).
MAX_FULL_BYTES="${JELLYBOT_PROD_LOG_MAX_BYTES:-20971520}"
MAX_SIGNALS_BYTES="${JELLYBOT_PROD_SIGNALS_MAX_BYTES:-5242880}"
HEALTH_URL="${JELLYBOT_HEALTH_URL:-http://127.0.0.1:8080/healthz}"

# Events OpenACP needs for diagnosis (keep in sync with docs/SMOKE.md / agent scope).
# Matches JSON "event":"..." fields and common error/warn tokens.
# Note: use quote\. / clip\. so quotewish.reconcile.tick does not match as "quote".
SIGNAL_PATTERN='"event":"(quote\.|clip\.|preview\.|discord\.|interaction\.|command\.|autocomplete\.|error|warn|fatal)|"event":"quotewish\.(fulfill|error|fail)|"event":"subtitle_index\.(error|fail)|"event":"[^"]*(_error|error\.)|"level":"(error|warn|fatal)"|Error:|ERROR |WARN |Unknown interaction|already been acknowledged'

mkdir -p "$LOG_DIR" "$STATE_DIR"

rotate_if_huge() {
  local file="$1" max="$2"
  [[ -f "$file" ]] || return 0
  local sz
  sz=$(wc -c <"$file" | tr -d ' ')
  if (( sz > max )); then
    mv -f "$file" "${file}.1"
  fi
}

if ! "$DOCKER" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[export-prod-logs] $(date -Iseconds) container ${CONTAINER} not found (docker=$DOCKER)" >&2
  # Still try healthz — may answer even if name drifted.
else
  # Incremental: only lines since last successful export. First run: last 2h.
  since="$(cat "$SINCE_FILE" 2>/dev/null || true)"
  if [[ -z "$since" ]]; then
    since="$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%S)"
  fi
  now="$(date -u +%Y-%m-%dT%H:%M:%S)"

  tmp="${OUT}.tmp.$$"
  if ! "$DOCKER" logs --timestamps --since "$since" "$CONTAINER" >"$tmp" 2>&1; then
    echo "[export-prod-logs] $(date -Iseconds) docker logs failed for ${CONTAINER}" >&2
    rm -f "$tmp"
  else
    if [[ -s "$tmp" ]]; then
      rotate_if_huge "$OUT" "$MAX_FULL_BYTES"
      cat "$tmp" >>"$OUT"

      sig_tmp="${SIGNALS}.tmp.$$"
      # shellcheck disable=SC2002
      grep -E "$SIGNAL_PATTERN" "$tmp" >"$sig_tmp" 2>/dev/null || true
      if [[ -s "$sig_tmp" ]]; then
        rotate_if_huge "$SIGNALS" "$MAX_SIGNALS_BYTES"
        cat "$sig_tmp" >>"$SIGNALS"
      fi
      rm -f "$sig_tmp"
    fi
    rm -f "$tmp"
    # Advance cursor only after a successful pull (overlap 30s for clock skew).
    overlap="$(date -u -d '30 seconds ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "$now")"
    echo "$overlap" >"$SINCE_FILE"
  fi
fi

# Health snapshot — OpenACP can read this without curl if networking is weird.
if "$CURL" -fsS --max-time 3 "$HEALTH_URL" >"${HEALTHZ_OUT}.tmp" 2>/dev/null; then
  mv -f "${HEALTHZ_OUT}.tmp" "$HEALTHZ_OUT"
else
  rm -f "${HEALTHZ_OUT}.tmp"
  printf '{"status":"unreachable","checkedAt":"%s","url":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HEALTH_URL" >"$HEALTHZ_OUT"
fi
