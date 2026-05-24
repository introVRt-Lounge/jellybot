# Jellybot

Discord slash command bot that searches your local Jellyfin library and posts video clips back to the channel.

[![CI](https://github.com/heavygee/jellybot/actions/workflows/ci.yml/badge.svg)](https://github.com/heavygee/jellybot/actions/workflows/ci.yml)

Links: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Repository settings](REPO_SETTINGS.md) · [Discord setup](DISCORD_SETUP.md)

## What it does

- `/clip` with a required `kind` choice: **Movie** or **TV episode**
- Jellyfin media autocomplete scoped to that kind
- `start` plus either `end` or `duration`
- ffmpeg extracts the segment from Jellyfin and uploads the MP4 to Discord

See [docs/COMMANDS.md](docs/COMMANDS.md) for the command contract and [DISCORD_SETUP.md](DISCORD_SETUP.md) for portal settings, permissions, and verification.

## Requirements

- Bun 1.3+ for local dev
- ffmpeg on `PATH` for non-container local runs
- Jellyfin reachable from the bot host
- Discord bot token with `applications.commands` scope

## Setup

```bash
cd ~/coding/jellybot
cp .env.example .env
bun install
```

Required env vars:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `JELLYFIN_USERNAME`
- `JELLYFIN_PASSWORD`

Optional:

- `JELLYFIN_URL` (default `http://127.0.0.1:8096`)
- `DISCORD_GUILD_ID` - instant guild command sync during development
- `MAX_CLIP_SECONDS` (default `120`)
- `MAX_CLIP_MB` (default `24`)
- `HEALTH_PORT` (default `8080`)
- `APP_VERSION` - shown on `/healthz`

## Run locally

```bash
bun run register-commands
bun run start
bun test
bun run secrets:staged
```

## Docker

Standard bot compose contract:

```bash
make test
make register-commands
make dev-refresh
make health
make logs
```

The runtime container:

- joins `traefik_net`
- talks to Jellyfin at `http://jellyfin:8096`
- exposes `GET /healthz` on port `8080`
- stores clip temp files in the `jellybot-tmp` volume

Production promotion uses an image-only compose file at [deploy/prod/docker-compose.yml](deploy/prod/docker-compose.yml):

```bash
docker pull ghcr.io/heavygee/jellybot:latest
docker compose -f deploy/prod/docker-compose.yml up -d --force-recreate
```

## Jellyfin access model

The bot authenticates as the configured Jellyfin user (`fam` by default), not an admin API key. Search and streaming follow that account's library access.

## Autocomplete notes

Discord validates later required options while autocomplete is open. That is why `start` is optional in the slash schema but enforced at runtime. Jellyfin searches are capped at 2.5 seconds and choice labels are compacted to Discord's 100-character limit.

## Project skills

Specialist skills materialized from `~/coding/skills` live in `.agents/skills/`:

- `discord-bot-creation-full-spec`
- `discord-bot-testing-discipline`
- `docker-setup-and-operation-for-bots`
- `docker-best-practices-for-projects`

## Example

```text
/clip kind:Movie media:The Matrix start:1:23:45 duration:30
/clip kind:TV episode media:Breaking Bad start:90 end:2:30
```

Timestamp formats: `90`, `90s`, `1:30`, `01:02:03`.
