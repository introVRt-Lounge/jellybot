# Repository Settings

Owner identity: `heavygee` via the default `gh` CLI identity.

Visibility: private.

## GitHub Security

Enable or verify these in GitHub after the repo exists:

- Dependabot alerts: enabled with `gh api --method PUT repos/heavygee/jellybot/vulnerability-alerts`
- Dependabot security updates: enabled with `gh api --method PUT repos/heavygee/jellybot/automated-security-fixes`
- Secret scanning: unavailable on this private repo plan (`422 Secret scanning is not available`)
- Secret push protection: unavailable on this private repo plan
- Branch protection: unavailable on this private repo plan (`403 Upgrade to GitHub Pro or make this repository public`)

Free private repos may not support every branch protection or advanced security control. The in-repo CI still provides:

- `secret-scan` using gitleaks
- `owasp-sast` using Semgrep OWASP/TypeScript/JavaScript/secrets rules
- aggregate `ci` job

## Merge Policy

Default path: branch -> PR -> green `ci` -> merge.

Solo direct push is allowed for fast private-app iteration only when followed by:

1. `bun run ci`
2. `make test`
3. command sync if slash schema changed
4. Docker runtime health check
5. clean git status

## Deployment

Development deploy:

```bash
make dev-refresh
make health
```

Production compose template:

```bash
deploy/prod/docker-compose.yml
```

Use image references in production; do not run production from a mutable checkout.
