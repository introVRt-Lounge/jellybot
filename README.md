# Jellybot

Discord slash command bot that searches your local Jellyfin library and posts video clips back to the channel.

[![CI](https://github.com/heavygee/jellybot/actions/workflows/ci.yml/badge.svg)](https://github.com/heavygee/jellybot/actions/workflows/ci.yml)

Links: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Repository settings](REPO_SETTINGS.md) · [Discord setup](DISCORD_SETUP.md)

## What it does

- `/clip` with a required `kind` choice: **Movie** or **TV episode**
- `/quote` searches indexed subtitles and clips the matching scene
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
- Clips render as **480p H.264** with AAC audio. Discord's inline player does not reliably decode HEVC/x265 (audio plays, video freezes).
- `MAX_CLIP_SECONDS` (default `180`)
- `MAX_CLIP_MB` (default `9`, capped by Discord's per-server `attachment_size_limit`; bots default to 10 MB)
- `HEALTH_PORT` (default `8080`)
- `APP_VERSION` - shown on `/healthz`
- `SUBTITLE_DB_PATH` (default `/tmp/jellybot/data/subtitles.db`, local Docker volume)
- `JELLYBOT_CLIP_DIR` (container path for ephemeral clips, default `/tmp/jellybot/clips`)
- Host clip storage defaults to `/mnt/drives/1tb_smb/jellybot-clips` via Compose bind mount
- `SUBTITLE_LANGUAGES` (default `eng,en`)
- `SUBTITLE_DEFAULT_CLIP_SECONDS` (default `15`)
- `SUBTITLE_QUOTE_PADDING_SECONDS` (default `2`)
- `SUBTITLE_INDEX_CONCURRENCY` (default `4`)
- `SUBTITLE_INDEX_ON_STARTUP` (`off` or `incremental`)

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
make index-subtitles
make dev-refresh
make health
make logs
```

Before `/quote` works, build the subtitle index once:

```bash
make index-subtitles
```

That walks Jellyfin items with subtitles (~76% of the library after Bazarr) and stores cue text in SQLite FTS. Re-run `make index-subtitles-incremental` after Bazarr adds new `.srt` files.

The runtime container:

- joins `traefik_net`
- talks to Jellyfin at `http://jellyfin:8096`
- exposes `GET /healthz` on port `8080`
- ephemeral clip files bind-mount to `JELLYBOT_CLIP_HOST_DIR` (default `/mnt/drives/1tb_smb/jellybot-clips`)
- **subtitle index (SQLite) stays on the main drive** via the local `jellybot-data` Docker volume (`/var/lib/docker/volumes/jellybot_jellybot-data/_data` on the host). Do not put it on SMB.

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
/quote match:love finds its way duration:15
```

Timestamp formats: `90`, `90s`, `1:30`, `01:02:03`.
