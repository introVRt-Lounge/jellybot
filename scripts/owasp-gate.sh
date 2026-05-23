#!/usr/bin/env bash
set -euo pipefail

if command -v semgrep >/dev/null 2>&1; then
  semgrep scan \
    --config p/owasp-top-ten \
    --config p/typescript \
    --config p/javascript \
    --config p/secrets \
    --config security/semgrep/jellybot.yml \
    --error
else
  docker run --rm -v "$PWD:/src" -w /src semgrep/semgrep:1.122.0 \
    semgrep scan \
      --config p/owasp-top-ten \
      --config p/typescript \
      --config p/javascript \
      --config p/secrets \
      --config security/semgrep/jellybot.yml \
      --error
fi
