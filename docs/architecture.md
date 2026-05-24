# Architecture

## Components

| Piece | Role |
|-------|------|
| Discord gateway | Slash commands, autocomplete, file upload |
| Jellyfin client | Authenticates as `JELLYFIN_USERNAME`; searches and streams media |
| ffmpeg | Renders H.264/AAC MP4 clips |
| SQLite FTS | Subtitle index for `/quote` |
| Health server | `GET /healthz` on port 8080 |

## Data paths (container)

| Path | Purpose |
|------|---------|
| `/var/lib/jellybot/clips` | Ephemeral rendered MP4s (deleted after upload) |
| `/var/lib/jellybot/data/subtitles.db` | Subtitle FTS index |

## Deploy shapes

- **Dev:** `docker compose --profile app` from the repo checkout
- **Prod:** `deploy/prod/docker-compose.yml` with `JELLYBOT_IMAGE=ghcr.io/introvrt-lounge/jellybot:latest`

CI publishes the runtime image to GHCR on every push to `main`.
