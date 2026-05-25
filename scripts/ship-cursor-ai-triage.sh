#!/usr/bin/env bash
# Branch, commit, push, PR for label-gated Cursor issue triage automation.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=introVRt-Lounge/jellybot
BRANCH=feat/cursor-ai-triage

echo "=== Branch from main ==="
git checkout main
git pull --ff-only origin main
git checkout -B "$BRANCH"

echo "=== Stage ==="
git add \
  .github/workflows/cursor-issue-triage.yml \
  .github/ISSUE_TEMPLATE/agent_task.yml \
  .github/labels.yml \
  CONTRIBUTING.md \
  AGENTS.md \
  REPO_SETTINGS.md

echo "=== Create GitHub issue ==="
ISSUE_JSON=$(jq -n \
  --arg title "[feat]: Label-gated Cursor Cloud Agent issue triage" \
  --arg body "Add GitHub Actions workflow triggered by \`ai-triage\` label (not every new issue). Includes agent task issue template, ai-* labels, CONTRIBUTING guardrails, and \`CURSOR_API_KEY\` secret documentation.

Uses osbytes/cursor-issue-triage@v1." \
  '{title: $title, body: $body, labels: ["enhancement", "triage"]}')
ISSUE=$(echo "$ISSUE_JSON" | gh api --method POST "repos/$REPO/issues" --input - --jq '{number, html_url}')
ISSUE_NUM=$(echo "$ISSUE" | jq -r .number)
ISSUE_URL=$(echo "$ISSUE" | jq -r .html_url)
echo "Issue: $ISSUE_URL"

echo "=== Commit ==="
git commit -m "$(cat <<EOF
feat(ci): label-gated Cursor issue triage workflow

Add ai-triage label trigger, agent issue template, guard labels,
and contributor rules for Cloud Agents.

Fixes #${ISSUE_NUM}
EOF
)"
COMMIT=$(git rev-parse HEAD)

echo "=== Push ==="
git push -u origin "$BRANCH"

PR_BODY=$(cat <<EOF
## Summary
- GitHub Action \`cursor-issue-triage.yml\` runs only when issue label \`ai-triage\` is applied (not on every \`opened\` event).
- New **Agent task** issue template applies \`ai-triage\` by default.
- Synced labels: \`ai-triage\`, \`ai-triage-enqueued\`, \`ai-safe\`, \`ai-investigate-only\`, \`ai-no-db\`, \`ai-no-auth\`, \`human-needed\`.
- Documented operator setup (\`CURSOR_API_KEY\`, Cursor GitHub integration) and agent rules in \`CONTRIBUTING.md\`.

## Test plan
- [ ] Merge label sync workflow updates GitHub labels
- [ ] Add \`CURSOR_API_KEY\` repo secret and connect Cursor GitHub integration
- [ ] Create test issue via Agent task template → confirm workflow does **not** double-fire if label removed before enqueue
- [ ] Apply \`ai-triage\` to a low-risk test issue → confirm agent enqueues and \`ai-triage-enqueued\` label appears

Fixes #${ISSUE_NUM}
EOF
)

PR=$(jq -n \
  --arg title "feat(ci): label-gated Cursor issue triage" \
  --arg body "$PR_BODY" \
  --arg head "$BRANCH" \
  --arg base "main" \
  '{title: $title, body: $body, head: $head, base: $base}' \
  | gh api "repos/$REPO/pulls" --method POST --input - --jq '{number, html_url}')

echo "Done. Issue: $ISSUE_URL | PR: $(echo "$PR" | jq -r .html_url) | Commit: $COMMIT"
