#!/usr/bin/env bash
# Poll Cursor Cloud Agent until terminal status, then post /conversation to the GitHub issue.
set -euo pipefail

REPOSITORY="${REPOSITORY:-introVRt-Lounge/jellybot}"
ISSUE_NUMBER="${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
AGENT_ID="${AGENT_ID:?AGENT_ID is required}"
: "${CURSOR_API_KEY:?CURSOR_API_KEY is required}"

POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-120}"
POLL_MAX_ATTEMPTS="${POLL_MAX_ATTEMPTS:-90}"
SKIP_POLL="${SKIP_POLL:-false}"

CONVERSATION_MARKER="jellybot-agent-conversation"
auth_header="Authorization: Basic $(printf '%s' "${CURSOR_API_KEY}:" | base64 -w0)"

cursor_api() {
  local path="$1"
  curl -fsS "https://api.cursor.com/v0${path}" \
    -H "${auth_header}" \
    -H "Content-Type: application/json"
}

terminal_status() {
  case "$1" in
    FINISHED | FAILED | EXPIRED | ERROR | CANCELLED) return 0 ;;
    *) return 1 ;;
  esac
}

agent_status="UNKNOWN"
if [ "${SKIP_POLL}" = "true" ]; then
  agent_status="$(cursor_api "/agents/${AGENT_ID}" | jq -r '.status')"
else
  for attempt in $(seq 1 "${POLL_MAX_ATTEMPTS}"); do
    agent_json="$(cursor_api "/agents/${AGENT_ID}")"
    agent_status="$(echo "${agent_json}" | jq -r '.status')"
    echo "Poll ${attempt}/${POLL_MAX_ATTEMPTS}: agent ${AGENT_ID} status=${agent_status}"
    if terminal_status "${agent_status}"; then
      break
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
  done
fi

if ! terminal_status "${agent_status}"; then
  echo "Agent ${AGENT_ID} did not reach a terminal status (last: ${agent_status})."
  exit 1
fi

agent_json="$(cursor_api "/agents/${AGENT_ID}")"
conversation_json="$(cursor_api "/agents/${AGENT_ID}/conversation")"

agent_name="$(echo "${agent_json}" | jq -r '.name // "Cursor agent"')"
agent_url="$(echo "${agent_json}" | jq -r '.target.url // empty')"
if [ -z "${agent_url}" ]; then
  agent_url="https://cursor.com/agents/${AGENT_ID}"
fi
branch_name="$(echo "${agent_json}" | jq -r '.target.branchName // empty')"
lines_added="$(echo "${agent_json}" | jq -r '.linesAdded // 0')"
files_changed="$(echo "${agent_json}" | jq -r '.filesChanged // 0')"

message_count="$(echo "${conversation_json}" | jq '.messages | length')"
last_assistant="$(echo "${conversation_json}" | jq -r '[.messages[] | select(.type == "assistant_message") | .text][-1] // "(no assistant summary)"')"

full_transcript="$(echo "${conversation_json}" | jq -r '
  .messages[]
  | if .type == "user_message" then
      "### User\n\n" + (.text | gsub("\r"; ""))
    else
      "### Assistant (" + .id + ")\n\n" + (.text | gsub("\r"; ""))
    end
')"

# GitHub issue comment limit is 65536; leave headroom for wrapper markdown.
max_transcript_chars=52000
if [ "${#full_transcript}" -gt "${max_transcript_chars}" ]; then
  full_transcript="${full_transcript:0:${max_transcript_chars}}

…(transcript truncated; open Cursor agent for full tool-level detail)"
fi

body="$(cat <<EOF
<!-- ${CONVERSATION_MARKER} -->

## Cursor agent transcript

| Field | Value |
| --- | --- |
| Agent | [\`${AGENT_ID}\`](${agent_url}) |
| Status | \`${agent_status}\` |
| Branch | \`${branch_name:-n/a}\` |
| Diff stats | +${lines_added} lines, ${files_changed} files |

### Outcome (last assistant message)

${last_assistant}

<details>
<summary>Full conversation (${message_count} messages)</summary>

${full_transcript}

</details>
EOF
)"

existing_comment_id="$(gh api "/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments?per_page=100" \
  --jq "[.[] | select(.body | contains(\"${CONVERSATION_MARKER}\")) | .id][0] // empty")"

if [ -n "${existing_comment_id}" ]; then
  gh api -X PATCH "/repos/${REPOSITORY}/issues/comments/${existing_comment_id}" -f body="${body}" >/dev/null
  echo "Updated conversation comment on issue #${ISSUE_NUMBER} (agent ${AGENT_ID}, status ${agent_status})."
else
  gh issue comment "${ISSUE_NUMBER}" --repo "${REPOSITORY}" --body "${body}" >/dev/null
  echo "Posted conversation comment on issue #${ISSUE_NUMBER} (agent ${AGENT_ID}, status ${agent_status})."
fi
