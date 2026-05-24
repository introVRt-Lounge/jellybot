#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "gitleaks staged scan must run inside a git repository" >&2
  exit 1
fi

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks protect --staged --redact --verbose
fi

if command -v docker >/dev/null 2>&1; then
  repo_root="$(git rev-parse --show-toplevel)"
  exec docker run --rm \
    -v "${repo_root}:/repo" \
    -w /repo \
    zricethezav/gitleaks:v8.30.1 \
    protect --staged --redact --verbose
fi

cat >&2 <<'EOF'
gitleaks is required for the pre-commit secret scan.

Install one of:
- gitleaks: https://github.com/gitleaks/gitleaks
- Docker, so the hook can run zricethezav/gitleaks:v8.30.1

Do not bypass this hook unless you have separately run the secret scan.
EOF
exit 1
