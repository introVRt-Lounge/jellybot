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
