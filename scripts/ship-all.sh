#!/usr/bin/env bash
# Ship audio/burn-in PR then Cursor triage PR (sequential).
set -euo pipefail
DIR="$(dirname "$0")"
bash "$DIR/ship-audio-burn-in-subtitles.sh"
bash "$DIR/ship-cursor-ai-triage.sh"
