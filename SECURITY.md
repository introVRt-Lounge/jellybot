# Security Policy

Jellybot is a Discord bot that can access the configured Jellyfin user's media libraries and upload clips into Discord.

## Reporting

Report vulnerabilities privately to the repository maintainer. Do not open public issues with exploit details, tokens, or media URLs.

## Secret Handling

- `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, and Jellyfin credentials belong only in `.env` or deployment secrets.
- Jellyfin server API keys are admin-level and must not be used for this bot.
- Authenticate as a least-privilege Jellyfin user via `JELLYFIN_USERNAME`, not an admin API key.
- Clip stream URLs include access tokens; do not log them.
- Local commits are guarded by Husky + gitleaks (`bun run secrets:staged`).

## Production Scope

The supported production runtime is the Docker container in this repository or an image pulled from your registry using `deploy/prod/docker-compose.yml`.

## Rotation

If a Discord token, Jellyfin password, or generated user token leaks:

1. Revoke or rotate it in Discord/Jellyfin immediately.
2. Update `.env` or deployment secrets.
3. Restart the container.
4. Run `bun run secrets:staged` and the CI `secret-scan` before pushing any follow-up commits.
