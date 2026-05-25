# Contributing

Pull requests welcome. Use normal PR flow; keep `main` green before merge.

**No ticket, no workee:** open a GitHub Issue for every feature or bug before implementation (use the issue templates). PRs should include `Fixes #N`.

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Local Setup

```bash
cp .env.example .env
bun install
bun run ci
```

`bun install` runs `prepare` and installs the Husky pre-commit hook. The hook runs `bun run secrets:staged`, which uses local `gitleaks` when present or the official Docker image `zricethezav/gitleaks:v8.30.1`.

For container parity:

```bash
make test
make dev-refresh
make health
```

## Slash Commands

Any command, option, autocomplete, or permission change must update:

- `README.md`
- `docs/COMMANDS.md`
- `DISCORD_SETUP.md` if scopes, intents, or permissions changed
- command contract tests in `tests/`

Run command sync after schema changes:

```bash
make register-commands
```

## Security And Secrets

- Never commit `.env`, `.env~`, tokens, Jellyfin passwords, or generated clips.
- Keep the Husky gitleaks hook enabled. If it flags a secret, rotate the secret instead of bypassing the hook.
- Use a least-privilege Jellyfin user via `JELLYFIN_USERNAME`, not a Jellyfin admin API key.
- Do not log Discord tokens, Jellyfin credentials, or clip source URLs with tokens.

## Commits And Releases

- Use conventional commit prefixes when possible (`feat:`, `fix:`, `docs:`, `build:`) for release-please compatibility.
- Merged conventional commits on `main` create semver GitHub Releases via `.github/workflows/release-please.yml`.
- Patch releases update GitHub but do **not** move `:latest` or trigger Discord announce noise; major/minor releases do both after Watchtower recreates prod.

## PR Checklist

- [ ] `bun run ci` passes
- [ ] `bun run secrets:staged` passes
- [ ] `make test` passes
- [ ] Command docs updated for slash-command changes
- [ ] Docker image starts and `/healthz` is healthy for runtime changes
- [ ] No secrets in the diff

## Cursor agent automation (label-gated)

Cursor Cloud Agents **do not** run on every new issue. They run when **`@radgey-cmd`** (issue triage) adds **`ai-triage`** or **`ai-safe`** after reviewing the ticket.

Workflow: `.github/workflows/cursor-issue-triage.yml` → [cursor-issue-triage](https://github.com/marketplace/actions/cursor-issue-triage) action → Cursor Cloud Agent. Requires repo secret **`CURSOR_API_KEY`** and Cursor Dashboard GitHub integration for this repo.

**Do not** rely on Cursor Dashboard Automations with **PR → label changed** triggers for issues — GitHub issue label events are not supported there. Use this GitHub Action path instead.

The workflow ignores labels applied by anyone other than `radgey-cmd`.

**Operator setup (once per repo):**

1. Cursor Dashboard → Cloud / Agents / Integrations → connect GitHub with access to this repo (API key alone is not enough for clone/PR).
2. GitHub repo → Settings → Secrets → Actions → `CURSOR_API_KEY`.

Optional guard labels (add manually; not all are enforced by automation yet):

| Label | Meaning |
| --- | --- |
| `ai-triage` | Cursor may inspect and attempt |
| `ai-safe` | Low-risk implementation allowed |
| `ai-investigate-only` | Comment with findings only; no code |
| `ai-no-db` | No migrations or schema changes |
| `ai-no-auth` | No auth/security changes |
| `human-needed` | Do not use agent automation |

### Cursor agent rules

When implementing GitHub issues (human or Cloud Agent):

1. Read the full issue body and comments before editing code.
2. If acceptance criteria are missing or ambiguous, do not implement. Comment with the missing information.
3. Prefer the smallest safe change.
4. Do not refactor unrelated code.
5. Do not change public APIs unless the issue explicitly asks for it.
6. Do not modify authentication, billing, secrets, deployment config, or database migrations unless the issue explicitly asks for it.
7. Run the relevant tests, linter, and type checker.
8. Open a PR with linked issue, summary, files changed, tests run, and risks or assumptions.
9. If tests cannot run, say exactly why.
