# Repository Settings

Checklist for GitHub hygiene when publishing or maintaining this repo.

## GitHub Security

Enable or verify:

- Dependabot alerts and security updates
- Secret scanning and push protection (available on public repos and paid plans)
- Branch protection on `main` requiring the `ci` check

Replace unavailable platform features with in-repo guards:

- `secret-scan` using gitleaks in CI
- `owasp-sast` using Semgrep
- Husky pre-commit hook running `gitleaks protect --staged`

## Merge Policy

Default path: branch -> PR -> green `ci` -> merge.

## Deployment

Development:

```bash
make dev-refresh
make health
```

Production compose template:

```bash
deploy/prod/docker-compose.yml
```

Use image references in production; do not run production from a mutable checkout.
