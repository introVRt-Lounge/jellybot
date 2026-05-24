# Limits

## Discord

- Autocomplete must respond within **3 seconds**
- Autocomplete choice names and values: **100 characters** max
- Non-boosted servers: bot upload default **10 MB** (`MAX_CLIP_MB` defaults to 9 for headroom)
- Inline player: prefer **H.264**; HEVC/x265 may show audio-only in Discord

## Jellybot defaults

| Setting | Default |
|---------|---------|
| `MAX_CLIP_SECONDS` | 180 |
| `MAX_CLIP_MB` | 9 |
| `CLIP_AUTOCOMPLETE_MAX_CONCURRENT` | 3 global Jellyfin searches for `/clip` media autocomplete |

## Jellyfin

The bot uses a least-privilege Jellyfin user (`JELLYFIN_USERNAME`), not an admin API key. Search and streaming follow that account's library access.
