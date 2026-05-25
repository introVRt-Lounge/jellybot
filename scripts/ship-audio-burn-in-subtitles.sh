#!/usr/bin/env bash
# One-shot: branch, issues, commit, CI, push, PR for English audio fix + subtitle burn-in.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=introVRt-Lounge/jellybot
BRANCH=feat/audio-fix-burn-in-subtitles

echo "=== 1. Git status / diff / log ==="
git status -sb
git diff --stat
git log -3 --oneline

echo "=== 2. Branch from main ==="
git checkout main
git pull --ff-only origin main
git checkout -b "$BRANCH"

echo "=== 3. Stage ==="
git add \
  docs/COMMANDS.md \
  src/audio-track-select.ts \
  src/commands/clip.ts \
  src/commands/quote.ts \
  src/ffmpeg.ts \
  src/services/clip-service.ts \
  src/subtitles/track-select.ts \
  src/subtitles/burn-in.ts \
  tests/audio-track-select.test.ts \
  tests/clip-command.test.ts \
  tests/ffmpeg.test.ts \
  tests/quote-command.test.ts \
  tests/subtitle-track-select.test.ts \
  tests/subtitle-burn-in.test.ts

echo "=== 4. Create GitHub issues ==="
BUG_JSON=$(jq -n \
  --arg title "[bug]: English audio - ffmpeg maps wrong stream" \
  --arg body "Clips selected the correct Jellyfin audio track but ffmpeg always mapped \`0:a:0?\` (first audio in container), producing foreign/default audio on multi-track items.

**Fix:** map \`0:{AudioStreamIndex}?\` when a preferred track is chosen; expand language matching for \`en-US\`, \`english\`, etc." \
  '{title: $title, body: $body, labels: ["bug", "triage"]}')
BUG=$(echo "$BUG_JSON" | gh api --method POST "repos/$REPO/issues" --input - --jq '{number, html_url}')
BUG_NUM=$(echo "$BUG" | jq -r .number)
BUG_URL=$(echo "$BUG" | jq -r .html_url)
echo "Bug issue: $BUG_URL"

FEAT_JSON=$(jq -n \
  --arg title "[feat]: Burn-in subtitles on /clip and /quote" \
  --arg body "Optional \`subtitles\` boolean on \`/clip\` and \`/quote\` burns the preferred Jellyfin subtitle track into rendered MP4s via ffmpeg \`subtitles=\` filter.

Fetches VTT/SRT from Jellyfin, shifts cues to clip window, writes temp SRT, burns in during encode." \
  '{title: $title, body: $body, labels: ["enhancement", "triage"]}')
FEAT=$(echo "$FEAT_JSON" | gh api --method POST "repos/$REPO/issues" --input - --jq '{number, html_url}')
FEAT_NUM=$(echo "$FEAT" | jq -r .number)
FEAT_URL=$(echo "$FEAT" | jq -r .html_url)
echo "Feat issue: $FEAT_URL"

echo "=== 5. CI before commit ==="
bun run ci | tee /tmp/jellybot-ci.log
CI_EXIT=${PIPESTATUS[0]}
if [[ "$CI_EXIT" -ne 0 ]]; then
  echo "CI failed (exit $CI_EXIT); fix before commit."
  exit "$CI_EXIT"
fi

echo "=== 6. Commit ==="
git commit -m "$(cat <<EOF
fix(clip): map ffmpeg audio stream and add subtitle burn-in

Map Jellyfin AudioStreamIndex in ffmpeg instead of 0:a:0; expand
en/en-US/english language matching. Add optional subtitles burn-in
on /clip and /quote.

Fixes #${BUG_NUM}
Fixes #${FEAT_NUM}
EOF
)"
COMMIT=$(git rev-parse HEAD)
echo "Commit: $COMMIT"

echo "=== 7. Push ==="
git push -u origin "$BRANCH"

echo "=== 8. PR ==="
CI_SUMMARY=$(tail -20 /tmp/jellybot-ci.log | sed 's/"/\\"/g')
PR_BODY=$(cat <<EOF
## Summary
- **English audio fix:** ffmpeg now maps \`0:{AudioStreamIndex}?\` when Jellyfin selects a preferred audio track; language matching handles \`en-US\`, \`english\`, and base-tag aliases.
- **Subtitle burn-in:** optional \`subtitles\` boolean on \`/clip\` and \`/quote\` fetches Jellyfin subs, shifts cues to clip range, burns in via ffmpeg \`subtitles=\` filter.

## Test plan
- [x] \`bun run ci\` (typecheck + tests) — see CI output below
- [ ] \`make register-commands\` — new \`subtitles\` option on slash commands
- [ ] Manual: \`/clip\` on multi-audio item — verify English audio
- [ ] Manual: \`/clip subtitles:True\` — verify burned-in subs
- [ ] Manual: \`/quote subtitles:True\` — verify quote clip with subs

### CI output
\`\`\`
$(cat /tmp/jellybot-ci.log)
\`\`\`

Fixes #${BUG_NUM}
Fixes #${FEAT_NUM}
EOF
)
jq -n \
  --arg title "fix(clip): English audio mapping and subtitle burn-in" \
  --arg body "$PR_BODY" \
  --arg head "$BRANCH" \
  --arg base "main" \
  '{title: $title, body: $body, head: $head, base: $base}' \
  | gh api "repos/$REPO/pulls" --method POST --input - --jq '{number, html_url}'

echo "Done. Bug: $BUG_URL | Feat: $FEAT_URL | Commit: $COMMIT"
