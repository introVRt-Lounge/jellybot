# Repository Settings

Operator checklist for **introVRt-Lounge/jellybot** (public).

## GitHub Security (Tier H)

| Control | Target | How to verify |
|---------|--------|---------------|
| Secret scanning | Enabled | Settings → Code security → Secret scanning |
| Secret push protection | Enabled | Settings → Code security → Push protection |
| CodeQL (default setup) | Enabled | Settings → Code security → Code scanning → Default setup |
| Dependabot alerts | Enabled | Settings → Security → Dependabot |
| Dependabot security updates | Enabled | Settings → Security → Dependabot |
| Private vulnerability reporting | Enabled | Settings → Security → Private vulnerability reporting |
| Branch protection `main` | Required check **`ci`** | Settings → Branches |
| GitHub Pages | Source: **GitHub Actions** | Settings → Pages (after first green `Docs` workflow) |
| Social preview | Upload `.github/social-preview.png` | Settings → General → Social preview |

Record last verified date when you audit these toggles.

## In-repo CI (Tier C + F-lite)

| Job | Purpose |
|-----|---------|
| `test` | Docker parity test suite |
| `security-audit` | `bun audit` on lockfile |
| `secret-scan` | gitleaks full tree |
| `owasp-sast` | Semgrep OWASP + project rules |
| **`ci`** | Aggregate gate - required for merge |

Local fallback: Husky pre-commit runs `bun run secrets:staged`.

## Container registry

| | |
|---|---|
| Registry | `ghcr.io` |
| Image | `ghcr.io/introvrt-lounge/jellybot` |
| Package | https://github.com/introVRt-Lounge/jellybot/pkgs/container/jellybot |
| Tags | `latest` + `main` on each `main` push; `sha-*`; semver on `v*` tags |

## Merge policy

Default: branch → PR → green **`ci`** → squash merge.

`delete_branch_on_merge` and squash merge are enabled.

## Deployment

Development:

```bash
make dev-refresh
make health
```

Production:

```bash
docker pull ghcr.io/introvrt-lounge/jellybot:latest
docker compose -f deploy/prod/docker-compose.yml up -d --force-recreate
```

## Labels

`.github/labels.yml` syncs via the `Sync labels` workflow on push to `main`.
