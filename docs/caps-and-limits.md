# Caps and limits

What Jellybot **can** do, what it **cannot** do, and the hard limits that shape both. Use this page before sizing hardware, tuning env vars, or expecting `/quote` to find every line in your library.

---

## What Jellybot can do

### Discord slash commands

| Command | Capability |
|---------|------------|
| **`/clip`** | Search Jellyfin (movies or TV episodes), pick a time range, render an MP4 clip, upload it to the channel |
| **`/quote`** | Full-text search over an indexed subtitle corpus, then clip the scene around a matched quote |

Both commands use Jellyfin as the media source and ffmpeg for rendering. Clips are re-encoded for Discord-friendly playback (H.264 + AAC by default).

### Jellyfin integration

- Authenticates as a **dedicated least-privilege user** (`JELLYFIN_USERNAME`) - not an admin API key
- Search and stream respect that user's library visibility (movies + TV libraries you configure)
- Reads **embedded text subtitle tracks** from Jellyfin (VTT/SRT-style streams exposed by the API)
- TV autocomplete can target specific seasons/episodes when you include tokens like `s03e03` in the media field

### Subtitle index (`/quote` backend)

- Builds a **SQLite FTS** database from Jellyfin subtitle streams
- **Incremental indexing** on startup by default (`SUBTITLE_INDEX_ON_STARTUP=incremental`)
- Manual maintenance: `make index-subtitles`, `make index-subtitles-incremental`
- Progress in `GET /healthz` → `subtitleIndex` (item count, cue count, last indexed timestamp)
- Index DB lives on a **host bind mount** (`JELLYBOT_DATA_HOST_DIR`) so backups can include it

### Operations

- Docker-first: GHCR image, Compose profiles (`app`, `test`, `index`, `register`)
- Health endpoint on port **8080** (`/healthz`)
- Ephemeral clip files under `/var/lib/jellybot/clips` (deleted after upload)

---

## What Jellybot cannot do

### Out of scope today

| Cannot | Why |
|--------|-----|
| **Transcode your whole library** | Jellybot clips short segments on demand; it is not a batch transcoder or Tdarr replacement |
| **Administer Jellyfin** | No user management, library scans, plugin config, or metadata editing |
| **Quote-search image-based subs (PGS/VobSub)** | Indexer requires **text** subtitle streams Jellyfin can expose as VTT/SRT |
| **Quote items with zero text subs** | Until OpenSubtitles or Whisper long-tail is enabled (see below), `/quote` only sees items Jellyfin marks as subtitled with a usable text track |
| **Guarantee Discord inline video on every client** | HEVC/x265 source may render but show **audio-only** in Discord's player; bot defaults to H.264 |
| **Bypass Discord upload caps** | Non-boosted servers stay on ~10 MB; the bot cannot raise Discord's limit |
| **Search across guilds you did not configure** | Guild allowlist via `DISCORD_GUILD_ID` / `DISCORD_GUILD_IDS` |
| **Run without ffmpeg + Jellyfin reachability** | Both are hard dependencies for clipping |

### Subtitle coverage reality

`/quote` quality is only as good as your **indexed cue corpus**:

1. **Today (built-in):** embedded Jellyfin text subs in preferred languages (`SUBTITLE_LANGUAGES`, default `eng,en`)
2. **Optional tier 2 (planned, [#24](https://github.com/introVRt-Lounge/jellybot/issues/24)):** OpenSubtitles.org API gap-fill when Jellyfin has no text track
3. **Optional tier 3 (planned, [#25](https://github.com/introVRt-Lounge/jellybot/issues/25)):** Whisper-class STT long-tail from audio when subs are missing entirely

If you already run **Bazarr** (or similar) to pull English subs into files on disk, Jellyfin may still need a library refresh before those tracks appear to the indexer. Jellybot does not replace Bazarr; it indexes what Jellyfin exposes.

---

## Hard limits

### Discord platform

| Limit | Value | Notes |
|-------|-------|-------|
| Autocomplete response time | **3 seconds** | Bot uses timeouts and concurrency guards |
| Autocomplete choice name/value | **100 characters** | Long titles are truncated |
| Autocomplete results | **25 choices** | Per Discord API |
| `/quote` match typing | **≥ 3 characters** | Before autocomplete search runs |
| `/clip` media typing | **≥ 2 characters** | Before Jellyfin search runs |
| Bot upload (typical non-boosted) | **~10 MB** | `MAX_CLIP_MB` defaults to **9** for headroom |
| Bot permissions required | Send Messages, Attach Files | In target channels |

### Jellybot env defaults

| Setting | Default | Effect |
|---------|---------|--------|
| `MAX_CLIP_SECONDS` | **180** | Maximum clip duration |
| `MAX_CLIP_MB` | **9** | Reject render above this size |
| `SUBTITLE_DEFAULT_CLIP_SECONDS` | **15** | `/quote` clip length |
| `SUBTITLE_QUOTE_PADDING_SECONDS` | **2** | Seconds before matched quote |
| `SUBTITLE_INDEX_CONCURRENCY` | **4** | Parallel Jellyfin fetches during indexing |
| `CLIP_AUTOCOMPLETE_MAX_CONCURRENT` | **3** | Global Jellyfin searches for `/clip` autocomplete |
| Clip minimum duration | **1 second** | Validation error below this |
| Render max height | **480p** | ffmpeg scale filter (Discord-friendly size) |

### Subtitle index scale

| Library scale (approx.) | SQLite size (approx.) |
|-------------------------|-------------------------|
| ~3,500 indexed items | ~1 GB |
| ~10,000 indexed items | **2–3 GB** |

Full rebuild can take **hours**. Treat `subtitles.db` as **backup-worthy state**, not disposable cache. See [Architecture - Subtitle index](architecture.md#subtitle-index).

---

## Optional: OpenSubtitles.org hookup

**Status:** documented for operators; native indexer integration tracked in [#24](https://github.com/introVRt-Lounge/jellybot/issues/24).

For users with an OpenSubtitles **API key** ([consumer portal](https://www.opensubtitles.com/en/consumers)):

### When to use it

- Jellyfin item has **no text subtitle track** (or only forced/foreign tracks you exclude)
- You want `/quote` coverage without manually hunting SRT files
- Bazarr is not in your stack, or Bazarr has not yet fetched a match

### Planned env (not wired in code yet)

```bash
# OPENSUBTITLES_ENABLED=true
# OPENSUBTITLES_API_KEY=your_api_key
# OPENSUBTITLES_USERNAME=your_username   # if required by API tier
# OPENSUBTITLES_PASSWORD=your_password
```

### Operator workflow today (without Jellybot native support)

1. Use **Bazarr** or OpenSubtitles manually to attach English subs to media files
2. Refresh Jellyfin library metadata
3. Run `make index-subtitles-incremental` (or wait for startup incremental pass)

When [#24](https://github.com/introVRt-Lounge/jellybot/issues/24) lands, Jellybot will attempt OpenSubtitles **during indexing** before giving up on an item.

---

## Optional: Whisper / STT long tail

**Status:** documented for operators; native indexer integration tracked in [#25](https://github.com/introVRt-Lounge/jellybot/issues/25).

Whisper-class speech-to-text can generate subtitle cues from **audio** when no text track exists. This is the **slow, expensive** path - batch/off-peak only, not interactive.

### Two deployment patterns

#### A) Bring your own STT endpoint (recommended)

Point Jellybot at any **OpenAI-compatible** transcriptions URL:

```bash
# WHISPER_LONG_TAIL_ENABLED=true
# WHISPER_STT_URL=http://127.0.0.1:18008/v1/audio/transcriptions
# WHISPER_STT_MODEL=Systran/faster-whisper-large-v3
```

The indexer (when implemented) will ffmpeg-extract audio, POST to that URL, parse the response into cues, and store them beside Jellyfin-sourced cues.

**Contract:** `POST /v1/audio/transcriptions` with multipart audio file + `model` field, JSON response with `text` or segment timings (exact segment support TBD in [#25](https://github.com/introVRt-Lounge/jellybot/issues/25)).

#### B) Optional Compose sidecar

If you do not already run STT, see [`docker-compose.subtitle-stt.example.yml`](../docker-compose.subtitle-stt.example.yml) for a minimal **speaches** (faster-whisper) sidecar you can colocate with Jellybot. Join the same Docker network and set `WHISPER_STT_URL=http://speaches:8000/v1/audio/transcriptions` (or your gateway URL).

### This operator environment (`introVRt-Lounge`)

| Service | Status | URL (loopback) | Notes |
|---------|--------|----------------|-------|
| **local-speech-agent / speaches** | **Running** | STT direct: `http://127.0.0.1:18001` | GPU faster-whisper (`Systran/faster-whisper-tiny.en` default in `.env.example`) |
| **local-speech-agent / realtime-gateway** | **Running** | `http://127.0.0.1:18008` | Preferred integration surface; maps `POST /v1/audio/transcriptions` → speaches |
| **whisper-transcriber** (server-setup) | **Dormant** | was `stuff.introvrtlounge.com/whisper` | OpenAI **cloud** API wrapper - not self-hosted Whisper |
| **WhisperJAV** (desktop) | Off this host | 4070 Ti box | JAV-specific; not general Jellyfin library batch |

**Recommendation for Jellybot long-tail here:** use **`http://127.0.0.1:18008/v1/audio/transcriptions`** (gateway) or **`http://127.0.0.1:18001`** (direct speaches). Upgrade model from `tiny.en` to **`large-v3`** (or similar) for movie dialogue accuracy before batch-indexing thousands of items.

**Friction mode:** tiny.en on GPU will "work" for a demo and fail silently on nuance at library scale. Cheapest falsification test: transcribe one 90-second clip you already have ground-truth subs for, diff the text, then decide if long-tail is worth the GPU hours.

### Model and cost tradeoffs

| Model class | Speed | Accuracy for film/TV dialogue |
|-------------|-------|--------------------------------|
| `tiny.en` | Fast | Poor - OK for smoke tests only |
| `base` / `small` | Medium | Usable for short clips |
| `large-v3` | Slow | Best default for quote search |

Full-length features at large-v3 across ~10k items is a **multi-day** batch job and will **grow** the subtitle DB further. Enable long-tail only for items that fail tiers 1 and 2.

---

## Quick reference: env vars

See [`.env.example`](../.env.example) for the full list. Subtitle-related:

| Variable | Purpose |
|----------|---------|
| `SUBTITLE_DB_PATH` | SQLite path inside container |
| `JELLYBOT_DATA_HOST_DIR` | Host bind mount for subtitle DB |
| `SUBTITLE_LANGUAGES` | Preferred track languages |
| `SUBTITLE_INDEX_ON_STARTUP` | `incremental` (default) or `off` |
| `SUBTITLE_INDEX_CONCURRENCY` | Indexer parallelism |
| `OPENSUBTITLES_*` | Planned OpenSubtitles gap-fill ([#24](https://github.com/introVRt-Lounge/jellybot/issues/24)) |
| `WHISPER_*` | Planned STT long-tail ([#25](https://github.com/introVRt-Lounge/jellybot/issues/25)) |

---

## Related docs

- [Commands](commands.md) - `/clip` and `/quote` options and failure cases
- [Architecture](architecture.md) - components, data paths, backup
- [COMMANDS.md (repo root contract)](../COMMANDS.md) - full slash-command specification
