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
| `/var/lib/jellybot/data/subtitles.db` | Subtitle FTS index (derived cache; see below) |

## Subtitle index

The FTS database is **derived** from Jellyfin VTT streams (rebuildable via `make index-subtitles`) but **expensive** to regenerate: a full library pass can take hours and produces a multi-GB SQLite file as coverage grows.

| Scale (approx.) | Size |
|-----------------|------|
| ~3,500 items indexed (~34% of subtitled library) | ~1 GB |
| Full subtitled library (~10k items) | likely **2–3 GB** |

Treat it as **state worth backing up**, not ephemeral bot state. Clips under `/var/lib/jellybot/clips` remain ephemeral.

### Backup (operator)

| | |
|---|---|
| **Host path** | `~/docker/jellybot/data/subtitles.db` (bind mount via `JELLYBOT_DATA_HOST_DIR`) |
| **Backup job** | `server-setup/scripts/backup/backup_docker_comprehensive.sh` → `docker_comprehensive.borg` |
| **Also in** | `coding.borg` backs up the git checkout only — **not** runtime DB unless under `~/coding` |

Avoid Compose **named volumes** for this DB; they sit under `/var/lib/docker/volumes/` and are outside the standard Borg path list.

### Index maintenance

- **On startup:** incremental index (`SUBTITLE_INDEX_ON_STARTUP=incremental`, default unless `off`)
- **Manual catch-up:** `make index-subtitles-incremental`
- **Full rebuild:** `make index-subtitles`
- **Progress:** `curl -s localhost:8080/healthz | jq .subtitleIndex`

## Deploy shapes

- **Dev:** `docker compose --profile app` from the repo checkout
- **Prod:** `deploy/prod/docker-compose.yml` with `JELLYBOT_IMAGE=ghcr.io/introvrt-lounge/jellybot:latest`

CI publishes the runtime image to GHCR on every push to `main`.
