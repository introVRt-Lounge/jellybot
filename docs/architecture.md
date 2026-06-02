# Architecture

## Visual map

Five diagrams, top-down, from where the bytes live to where the user sees a clip. GitHub renders mermaid natively; click any node to read the prose section that backs it up.

### 1. System topology

Containers, storage, and the GitHub deploy edge.

```mermaid
flowchart LR
  user(["Discord user"])
  subgraph dc["Discord"]
    gw["Discord gateway"]
  end
  subgraph host["Host server (~/docker/*)"]
    bot["jellybot<br/>:8080 /healthz + /hooks/*"]
    jf["jellyfin<br/>:8096"]
    radarr["radarr<br/>:7878"]
    sonarr["sonarr<br/>:8989"]
    bazarr["bazarr<br/>:6767"]
    sab["sabnzbd<br/>(via VPN)"]
    watchtower["watchtower"]
  end
  subgraph storage["Storage (host bind-mount)"]
    media[("/media/movies<br/>/media/tv")]
    db[("subtitles.db<br/>SQLite FTS5")]
  end
  subgraph github["GitHub"]
    repo["introVRt-Lounge/jellybot"]
    ghcr[("ghcr.io/...<br/>jellybot:latest")]
  end

  user <-->|slash commands| gw
  gw <--> bot
  bot -->|REST + subtitle stream| jf
  bot -->|REST acquire| radarr
  bot -->|REST acquire| sonarr
  bot --> db
  jf --> media
  radarr -->|grab| sab --> media
  sonarr -->|grab| sab --> media
  bazarr -->|fetch SRT| media
  bazarr -->|provider poll| sonarr
  bazarr -->|provider poll| radarr
  repo -->|Ship main| ghcr
  ghcr -->|pull on label change| watchtower --> bot
```

### 2. `/quote` happy path

Subtitle is already indexed. Keystroke to clip in a couple of seconds.

```mermaid
sequenceDiagram
  autonumber
  actor U as Discord user
  participant D as Discord gateway
  participant B as jellybot
  participant FTS as subtitles.db (FTS5)
  participant JF as Jellyfin
  participant FF as ffmpeg

  U->>D: /quote query="cunning plan"
  D->>B: AutocompleteInteraction
  B->>FTS: MATCH "cunning plan"
  FTS-->>B: top hits (item_id, ts, snippet)
  B-->>D: up to 25 autocomplete choices
  U->>D: pick a choice
  D->>B: ChatInputCommand (token = item | ts)
  B->>JF: stream + seek (~15s window)
  JF-->>B: media bytes
  B->>FF: render H.264 / AAC MP4
  FF-->>B: clip.mp4 (validated by ffprobe)
  B->>D: editReply with attachment
  D-->>U: clip posted
  B->>B: rm clip.mp4
```

### 3. `/quote` miss → acquisition

The big one. User asks for a quote we don't have, bot acquires the media, fetches subs, indexes, then auto-posts the clip.

```mermaid
sequenceDiagram
  autonumber
  actor U as Discord user
  participant D as Discord gateway
  participant B as jellybot
  participant R as Radarr
  participant S as Sonarr
  participant DL as sabnzbd
  participant BZ as Bazarr
  participant M as media volume
  participant JF as Jellyfin
  participant FTS as subtitles.db (FTS5)
  participant FF as ffmpeg

  U->>D: /quote query="..."
  D->>B: Autocomplete (no FTS hit)
  B-->>D: choice "Can't find it? click & submit"
  U->>D: pick that choice
  D->>B: ChatInputCommand (escape token)
  B-->>D: ephemeral select Movie / TV

  alt Movie
    U->>D: select Movie
    D->>B: StringSelect
    B-->>D: open movie modal
    U->>D: submit (title + quote)
    D->>B: ModalSubmit
    B->>R: lookup + add (or attach to existing)
    R-->>B: tmdbId, monitored=true
  else TV
    U->>D: select TV
    D->>B: StringSelect
    B-->>D: open TV modal
    U->>D: submit (show + S + E + quote)
    D->>B: ModalSubmit
    B->>S: lookup + add series + monitor episode
    S-->>B: tvdbId, episode monitored
  end

  B->>B: persist quote_request (acquisition_status=searching)
  B-->>D: ephemeral confirmation

  par grab
    R->>DL: send NZB
    S->>DL: send NZB
    DL-->>R: imported file
    DL-->>S: imported file
  end

  R->>BZ: import event (provider poll)
  S->>BZ: import event (provider poll)
  BZ->>BZ: fetch English SRT
  BZ->>M: write .srt sidecar

  loop reconciler tick (~30s)
    B->>JF: list HasSubtitles=true (incremental)
    JF-->>B: new item visible
    B->>JF: fetch SRT/VTT stream
    JF-->>B: cues
    B->>FTS: insert
  end

  loop reconciler match
    B->>FTS: search request quote
    FTS-->>B: hit (item_id, ts)
    B->>JF: stream + seek
    B->>FF: render clip
    FF-->>B: clip.mp4
    B->>D: post in channel + ping requester
  end
```

### 4. Subtitle index triggers

Four paths feed the same indexer. The webhook path is wired but currently a no-op until [#126](https://github.com/introVRt-Lounge/jellybot/issues/126) lands; safety nets cover it meanwhile.

```mermaid
flowchart TD
  A["Bot startup<br/>SUBTITLE_INDEX_ON_STARTUP=incremental"]
  B["Daily cron<br/>09:00 UTC"]
  C["Webhook kick<br/>POST /hooks/{radarr,sonarr,bazarr}<br/>broken on prod data, see #126"]
  D["Manual CLI<br/>bun run src/cli/index-subtitles.ts --incremental"]

  E["src/subtitles/indexer.ts"]
  F["Jellyfin GET /Items HasSubtitles=true"]
  G{"dateLastRefreshed<br/>newer than stored?"}
  H["fetch SRT/VTT stream"]
  I["parse cues"]
  J[("subtitle_cues_fts<br/>+ media_items")]
  K["skip"]

  A --> E
  B --> E
  C --> E
  D --> E
  E --> F --> G
  G -->|no| K
  G -->|yes| H --> I --> J
```

### 5. Deploy + self-heal

How code gets to production and how the host keeps containers honest.

```mermaid
flowchart LR
  subgraph dev["Local"]
    pr["PR merged to main"]
  end
  subgraph ci["GitHub Actions"]
    ship["Ship main<br/>build + push :latest<br/>(major/minor only)"]
  end
  subgraph reg["Registry"]
    ghcr[("ghcr.io/.../jellybot:latest")]
  end
  subgraph prod["Production host"]
    wt["watchtower"]
    cmp["docker compose<br/>~/docker/jellybot/"]
    bot["jellybot container"]
    rec["recreate.sh<br/>(atomic --force-recreate<br/>--remove-orphans)"]
    pc["protect-containers.sh<br/>monitors + heals<br/>transient _name"]
  end

  pr --> ship --> ghcr
  ghcr -->|new digest| wt -->|pull + recreate| cmp --> bot
  rec -.->|operator: env changes| cmp
  pc -.->|every minute| bot
  pc -.->|rename if<br/>transient| bot
```

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
| `/var/lib/jellybot/data/bot-state.db` | Release announce dedupe (`last_announced_release`) |

## Production release announce

On **every bot restart** (including Watchtower image upgrades), `ClientReady` runs a **one-shot** release check:

1. `GET /repos/{owner}/{repo}/releases/latest` with `GITHUB_TOKEN`
2. Compare `tag_name` to `last_announced_release` in `bot-state.db`
3. **Patch** (`vX.Y.Z` where `Z > 0`): update DB silently, no Discord post
4. **Major/minor**: optional 60s grace, re-fetch, summarize notes (OpenAI when configured), embed to `NOTIFICATION_CHANNEL_ID`

There is **no** scheduled/hourly poll. Repeat restarts on the same release are no-ops via DB dedupe.

Required prod env: `GITHUB_TOKEN`, `NOTIFICATION_CHANNEL_ID` (introVRt Lounge announcements: `1159798255295660103`). Major/minor embeds include **Feature credits** from GitHub `feat` commits/PR authors in the release range, and **Community thanks** when closed issues in the release include `Reported by @githubLogin` (Discord pings use `src/release/github-discord-members.ts`).

Retroactive patch announce (operator): `bun run announce:release v1.2.2 --allow-patch` with prod env loaded.

Release pipeline: conventional commits → release-please → GitHub Release → CI pushes GHCR (`:latest` on major/minor only) → Watchtower recreates container → announce on boot.

## Subtitle index

The FTS database is **derived** from Jellyfin VTT streams (rebuildable via `make index-subtitles`) but **expensive** to regenerate: a full library pass can take hours.

### Size (measured + projected)

| Scale | Raw cue text | DB file (legacy trigram) |
|-------|--------------|---------------------------|
| ~5,100 items (~49%) | **157 MiB** | **2.43 GiB** |
| ~10,409 items (full Jellyfin-subtitled pool) | **~319 MiB** (projected) | **~4.9 GiB** (projected, trigram) |

Disk is dominated by the **FTS5 inverted index**, not subtitle prose. Legacy schema used `tokenize='trigram'` (~71% of bytes in `subtitle_cues_fts_data`). New deployments migrate to **`unicode61`** word search (smaller index; see [#27](https://github.com/introVRt-Lounge/jellybot/issues/27)). Migration rebuilds FTS from existing `subtitle_cues` rows on startup.

Treat `subtitles.db` as **state worth backing up**, not ephemeral bot state. Clips under `/var/lib/jellybot/clips` remain ephemeral.

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
- **Prod:** `deploy/prod/docker-compose.yml` with `JELLYBOT_IMAGE=ghcr.io/introvrt-lounge/jellybot:latest` and Watchtower labels

CI publishes the runtime image to GHCR on every push to `main`. **Patch** semver tags do not move `:latest`; **major/minor** tags do, which triggers Watchtower and the on-boot release announce.
