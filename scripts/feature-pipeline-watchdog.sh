#!/usr/bin/env bash
# Inspect blessed feature issues and post/update pipeline status on GitHub + Discord when stuck.
set -euo pipefail

REPOSITORY="${REPOSITORY:-introVRt-Lounge/jellybot}"
DISCORD_WEBHOOK_URL="${DISCORD_PIPELINE_ALERT_WEBHOOK_URL:-${DISCORD_TRIAGE_DISPATCH_WEBHOOK_URL:-}}"

issue_numbers="$(gh issue list --repo "${REPOSITORY}" --label "discord-triage-blessed" --state all --limit 30 --json number -q '.[].number' || true)"

if [ -z "${issue_numbers}" ]; then
  echo "No blessed issues to inspect."
  exit 0
fi

for ISSUE_NUMBER in ${issue_numbers}; do
  echo "=== Issue #${ISSUE_NUMBER} ==="

  issue_json="$(gh issue view "${ISSUE_NUMBER}" --repo "${REPOSITORY}" --json state,title,url,labels)"
  issue_state="$(echo "${issue_json}" | jq -r '.state')"
  issue_title="$(echo "${issue_json}" | jq -r '.title')"
  issue_url="$(echo "${issue_json}" | jq -r '.url')"
  labels="$(echo "${issue_json}" | jq -r '[.labels[].name] | join(", ")')"

  BRANCH_NAME="ai-triage/fix-issue-${ISSUE_NUMBER}"
  branch_exists="false"
  if gh api "/repos/${REPOSITORY}/branches/${BRANCH_NAME}" >/dev/null 2>&1; then
    branch_exists="true"
  fi

  agent_id="$(gh api "/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments?per_page=100" \
    --jq '[.[] | select(.body | test("jellybot-pipeline-agent-id:")) | .body][0] // empty' \
    | grep -Eo 'jellybot-pipeline-agent-id:[[:space:]]*[a-zA-Z0-9-]+' \
    | head -1 \
    | sed 's/.*:[[:space:]]*//' || true)"

  pr_json="$(gh pr list --repo "${REPOSITORY}" --head "${REPOSITORY%%/*}:${BRANCH_NAME}" --state all --json number,state,mergedAt,url --limit 1)"
  pr_number="$(echo "${pr_json}" | jq -r '.[0].number // empty')"
  pr_url="$(echo "${pr_json}" | jq -r '.[0].url // empty')"
  pr_merged="$(echo "${pr_json}" | jq -r '.[0].mergedAt // empty')"

  ci_conclusion=""
  scope_conclusion=""
  if [ -n "${pr_number}" ]; then
    ci_conclusion="$(gh pr view "${pr_number}" --repo "${REPOSITORY}" --json statusCheckRollup \
      -q '[.statusCheckRollup[] | select(.name == "ci") | .conclusion][0] // empty')"
    scope_conclusion="$(gh pr view "${pr_number}" --repo "${REPOSITORY}" --json statusCheckRollup \
      -q '[.statusCheckRollup[] | select(.name == "scope-review") | .conclusion][0] // empty')"
  fi

  stage="unknown"
  blocker=""

  if ! echo "${labels}" | grep -Fq "discord-triage-blessed"; then
    stage="not_blessed"
    blocker="Not blessed."
  elif [ "${issue_state}" = "CLOSED" ] && [ -z "${pr_merged}" ]; then
    stage="failed"
    blocker="Issue closed before ship — Cursor may not open a PR (check accidental Fixes #N)."
  elif ! echo "${labels}" | grep -Fq "ai-triage-enqueued"; then
    stage="awaiting_enqueue"
    blocker="Triage workflow has not enqueued the agent yet."
  elif [ -z "${agent_id}" ] && [ "${branch_exists}" = "false" ]; then
    stage="awaiting_agent"
    blocker="Agent enqueued but no agent comment or branch yet."
  elif [ "${branch_exists}" = "false" ]; then
    stage="awaiting_branch"
    blocker="Waiting for branch ${BRANCH_NAME}."
  elif [ -z "${pr_number}" ]; then
    stage="awaiting_pr"
    blocker="Branch pushed but no PR — pipeline stuck here."
  elif [ "${ci_conclusion}" != "SUCCESS" ] && [ -n "${pr_number}" ]; then
    stage="awaiting_ci"
    blocker="CI is ${ci_conclusion:-pending}."
  elif [ "${scope_conclusion}" != "SUCCESS" ] && [ -n "${pr_number}" ]; then
    stage="awaiting_scope_review"
    blocker="Scope review is ${scope_conclusion:-pending}."
  elif [ -z "${pr_merged}" ]; then
    stage="awaiting_merge"
    blocker="PR #${pr_number} not merged yet."
  else
    stage="awaiting_ship"
    blocker="Merged — waiting for Ship main + Watchtower."
  fi

  body="$(cat <<EOF
<!-- jellybot-pipeline-status -->

**Jellybot pipeline status** (auto-updated)

| Step | Status |
| --- | --- |
| Blessed | $(echo "${labels}" | grep -Fq "discord-triage-blessed" && echo "✅" || echo "⏳") |
| Enqueued | $(echo "${labels}" | grep -Fq "ai-triage-enqueued" && echo "✅" || echo "⏳") |
| Agent | $([ -n "${agent_id}" ] && echo "✅ \`${agent_id}\`" || echo "⏳") |
| Branch \`${BRANCH_NAME}\` | $([ "${branch_exists}" = "true" ] && echo "✅" || echo "⏳") |
| Pull request | $([ -n "${pr_number}" ] && echo "✅ #${pr_number}" || echo "❌ missing") |
| CI | $([ "${ci_conclusion}" = "SUCCESS" ] && echo "✅" || echo "⏳ ${ci_conclusion:-pending}") |
| Scope review | $([ "${scope_conclusion}" = "SUCCESS" ] && echo "✅" || echo "⏳ ${scope_conclusion:-pending}") |
| Merged | $([ -n "${pr_merged}" ] && echo "✅" || echo "⏳") |
| Issue open | $([ "${issue_state}" = "OPEN" ] && echo "✅" || echo "⚠️ closed") |

**Stage:** \`${stage}\`
**Blocker:** ${blocker:-none}

Discord: \`/feature status issue:${ISSUE_NUMBER}\`
EOF
)"

  existing_comment_id="$(gh api "/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments?per_page=100" \
    --jq '[.[] | select(.body | contains("jellybot-pipeline-status")) | .id][0] // empty')"

  if [ -n "${existing_comment_id}" ]; then
    gh api -X PATCH "/repos/${REPOSITORY}/issues/comments/${existing_comment_id}" -f body="${body}" >/dev/null
    echo "Updated pipeline comment on #${ISSUE_NUMBER} (${stage})."
  else
    gh issue comment "${ISSUE_NUMBER}" --repo "${REPOSITORY}" --body "${body}" >/dev/null
    echo "Posted pipeline comment on #${ISSUE_NUMBER} (${stage})."
  fi

  if [ "${stage}" = "awaiting_pr" ] || [ "${stage}" = "failed" ]; then
    if [ -n "${DISCORD_WEBHOOK_URL}" ]; then
      alert="Pipeline stuck on **#${ISSUE_NUMBER}** (\`${stage}\`): ${blocker} — [issue](${issue_url})"
      curl -fsS -X POST "${DISCORD_WEBHOOK_URL}" \
        -H "Content-Type: application/json" \
        --data "$(jq -n --arg content "${alert}" '{content: $content}')" >/dev/null || true
      echo "Discord alert sent for #${ISSUE_NUMBER}."
    fi
  fi
done
