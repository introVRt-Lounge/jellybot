# Repository Settings

Operator checklist for **introVRt-Lounge/jellybot** (public).

## GitHub Security (Tier H)

| Control | Target | How to verify |
|---------|--------|---------------|
| Secret scanning | Enabled | Settings → Code security → Secret scanning |
| Secret push protection | Enabled | Settings → Code security → Push protection |
| CodeQL (default setup) | Enabled | Settings → Code security → Code scanning → Default setup |
| Code Quality (public preview) | Enabled | `PATCH …/code-quality/setup` — JS/TS + Python; weekly on `main` |
| Dependabot alerts | Enabled | Settings → Security → Dependabot |
| Dependabot security updates | Enabled | Settings → Security → Dependabot |
| Private vulnerability reporting | Enabled | `PUT …/private-vulnerability-reporting` |
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

**Cursor agent PRs:** when the linked issue has **`ai-safe`**, head branch is `ai-triage/*`, the PR body includes `Fixes #N` / `Closes #N`, and required check **`ci`** passes, `.github/workflows/cursor-ai-automerge.yml` marks draft PRs ready and enables squash **auto-merge**. Issues with **`human-needed`** are excluded. PRs from **`ai-triage`** (without `ai-safe`) still need manual merge.

## Deployment

| Tree | Purpose |
|------|---------|
| `~/coding/jellybot-dev` | Local git checkout — build, test, `make dev-refresh` (container `jellybot-dev`) |
| `~/docker/jellybot` | Production — GHCR image, Watchtower, container **`jellybot`** |

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full dev/prod contract.

Development:

```bash
cd ~/coding/jellybot-dev
make dev-refresh
make health
```

Production (operator host):

```bash
cd ~/docker/jellybot
docker compose pull && docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:8080/healthz | jq .
```

Template compose: [deploy/prod/docker-compose.yml](deploy/prod/docker-compose.yml) and [deploy/prod/docker-compose.host.example.yml](deploy/prod/docker-compose.host.example.yml).

## Labels

`.github/labels.yml` syncs via the `Sync labels` workflow on push to `main`.

## Subtitle index and backup

| | |
|---|---|
| **Purpose** | FTS cache for `/quote` — derived from Jellyfin, hours to rebuild |
| **Host path (prod)** | `/home/heavygee/docker/jellybot/data/subtitles.db` |
| **Compose** | `JELLYBOT_DATA_HOST_DIR=/home/heavygee/docker/jellybot/data` |
| **Backup** | `backup_docker_comprehensive.borg` (with other `~/docker/*` configs) |
| **Startup indexing** | `SUBTITLE_INDEX_ON_STARTUP=incremental` (default) |
| **Health** | `curl -s localhost:8080/healthz \| jq .subtitleIndex` |

Use a bind mount, not a named Docker volume — volumes under `/var/lib/docker/volumes/` are outside system Borg jobs.

**Permissions:** data dir owned by uid **1001** (`jellybot`) for SQLite WAL files.

## Cursor Cloud Agent (label-gated)

| | |
|---|---|
| **Trigger** | Issue label `ai-triage` applied by **`radgey-cmd`** only (`.github/workflows/cursor-issue-triage.yml`) |
| **Action** | [cursor-issue-triage](https://github.com/marketplace/actions/cursor-issue-triage) `@v1` |
| **Repo secret** | `CURSOR_API_KEY` — Settings → Secrets → Actions |
| **Cursor dashboard** | Connect GitHub integration with access to this repo (required for clone/PR; API key alone is insufficient) |
| **Enqueue marker** | Label `ai-triage-enqueued` applied by the action |
| **Auto-merge** | `.github/workflows/cursor-ai-automerge.yml` — `ai-safe` issue + `ai-triage/*` branch + green **`ci`** |

Do **not** trigger on every `issues.opened` event. File via the **Agent task** template; **`@radgey-cmd`** adds `ai-triage` or `ai-safe` when ready.

## Docs site (marketing URL)

| | |
|---|---|
| **Target URL** | https://jellybot.introvrtlounge.com |
| **Build** | MkDocs workflow → GitHub Pages |
| **Custom domain** | `docs/CNAME` + repo Settings → Pages |
| **DNS** | `CNAME jellybot` → `introvrt-lounge.github.io` |
