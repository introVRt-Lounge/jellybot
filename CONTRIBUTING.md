# Contributing

Jellybot is a private app owned by `heavygee`. Use normal pull requests for shared work; solo direct pushes are acceptable only with a wrap-up pass that leaves `main` green, deployed, and clean.

## Local Setup

```bash
cp .env.example .env
bun install
bun run ci
```

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
- Use the `fam` Jellyfin user or another least-privilege user, not a Jellyfin admin API key.
- Do not log Discord tokens, Jellyfin credentials, or clip source URLs with tokens.

## PR Checklist

- [ ] `bun run ci` passes
- [ ] `make test` passes
- [ ] Command docs updated for slash-command changes
- [ ] Docker image starts and `/healthz` is healthy for runtime changes
- [ ] No secrets in the diff
