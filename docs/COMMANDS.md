# Commands

## `/clip`

Create a Jellyfin clip, preview it privately, then post it to the current channel when ready.

### Options

| Option | Required at runtime | Type | Notes |
| --- | --- | --- | --- |
| `kind` | Yes | Choice | `Movie` or `TV episode` |
| `media` | Yes | Autocomplete string | Jellyfin item UUID. For TV, include `s03` or `s03e03` in this field to reach later seasons. |
| `start` | Yes | String | Timestamp such as `90`, `1:30`, `01:02:03` |
| `end` | One of end/duration | String | Absolute end timestamp |
| `duration` | One of end/duration | String | Length from `start` |
| `subtitles` | No | Boolean | When `true`, burns the preferred Jellyfin subtitle track into the clip video |

`start` is optional in the Discord command schema so autocomplete on `media` works while later options are still empty. The bot rejects the command if `start` is missing.

### Examples

```text
/clip kind:Movie media:The Matrix start:1:23:45 duration:30
/clip kind:TV episode media:Breaking Bad s05e14 start:90 end:2:30 subtitles:True
/clip kind:TV episode media:Spitting Image s03e03 start:1:00 duration:15s
```

### Failure cases

- missing `start`
- both `end` and `duration`
- neither `end` nor `duration`
- invalid timestamp format
- end before start
- clip shorter than 1 second
- clip longer than `MAX_CLIP_SECONDS`
- Jellyfin item not visible to the configured user
- wrong item type for selected `kind`
- start beyond runtime
- rendered file above `MAX_CLIP_MB`
- subtitle burn-in requested but Jellyfin has no usable subtitle track for the clip range
- ffmpeg/Jellyfin stream failure

### Preview and approval

After rendering, the bot sends an **ephemeral** preview (only you can see it) with the MP4 attached and three buttons:

| Action | Behavior |
| --- | --- |
| **Post** | Uploads the same rendered file to the channel with the clip summary |
| **Cancel** | Discards the preview and deletes the temp file; nothing is posted |
| **Try again** | Opens a modal to adjust `start` and `duration`, then re-renders a new preview |

Previews expire after about 14 minutes. `MAX_CLIP_SECONDS` and `MAX_CLIP_MB` still apply during preview and re-render.

### Permissions

The bot needs Send Messages and Attach Files in the target channel.

### Manual verification after command changes

1. Run `make register-commands` or the compose register profile
2. In Discord, pick `kind`, then type at least 2 characters in `media`
3. Confirm autocomplete returns compact labels within 3 seconds
4. Run one happy-path clip: confirm ephemeral preview, **Post** appears in channel, **Cancel** posts nothing
5. Run one validation failure

## `/quote`

Search indexed subtitles and clip the scene around a matched quote. Uses the same ephemeral preview flow as `/clip` (**Post**, **Cancel**, **Try again** with `duration` and `padding`).

### Options

| Option | Required | Type | Notes |
| --- | --- | --- | --- |
| `match` | Yes | Autocomplete string | Type at least 3 characters, then pick a quote match |
| `duration` | No | String | Clip length from the quote (default `15s`) |
| `padding` | No | String | Seconds before the quote (default `2s`) |
| `subtitles` | No | Boolean | When `true`, burns the preferred Jellyfin subtitle track into the clip video |

The subtitle index must exist first. Run `make index-subtitles` on the host/container before expecting matches.

### Examples

```text
/quote match:love finds its way
/quote match:does love happen duration:20 padding:3 subtitles:True
```

### Failure cases

- subtitle index missing or stale for the selected match
- free-typed `match` text instead of an autocomplete pick or the missing-quote submission entry
- clip longer than `MAX_CLIP_SECONDS`
- rendered file above Discord upload limit
- Jellyfin item no longer visible to the configured user

### Missing-quote submission flow

Every `/quote` autocomplete response includes a final synthetic entry: **`Can't find it? Click and SUBMIT this choice - you can request it!`**. Picking and submitting that entry replies with an ephemeral message asking *"Were you looking for a movie or a TV show?"* and a select menu with two options.

#### Movie path

Picking **Movie** opens a modal with two fields:

| Field | Required | Notes |
| --- | --- | --- |
| `Movie title` | Yes | Best guess; year helps but is optional. Free text, max 200 chars. |
| `The line you want` | Yes | The quote, as best as you remember it. Max 500 chars. |

On submit:

1. The bot looks up the title in Radarr (TMDB-backed search), picks the best candidate by title similarity + year hint, and **auto-adds it to Radarr** with the configured root folder + quality profile (defaults to `HD-1080p (no 4K)` when present, otherwise the first available 1080p profile).
2. A row is persisted in `quote_requests` with `acquisition_kind='radarr'` and the Radarr movie id.
3. A reconciler runs every 5 minutes:
   - Polls Radarr for the movie's `hasFile` flag.
   - Once Radarr reports `hasFile=true`, triggers a Jellyfin library refresh and waits for the item to show up.
   - Once the item shows up in Jellyfin, the next subtitle-index pass (or `make index-subtitles`) populates the FTS database.
   - When the requested quote matches a cue in the new item, the bot **renders the clip with the configured default duration + padding and posts the MP4 directly** in the original channel, @-mentioning the requester. The cue text and a `match:` token are included in the message so the user can re-clip with different timing if they want. If clip rendering fails (item gone, oversized, ffmpeg error), the bot falls back to a text-only fulfillment with just the cue + token.

Auto-approval is intentional: Radarr is configured to refuse 4K REMUX size profiles, so the cap is the operator's existing quality discipline, not a per-request gate. If `RADARR_URL`/`RADARR_API_KEY` are unset, the bot falls back to a passive watch-and-notify mode (no acquisition, just notifies if the quote appears later from a manual SRT or Bazarr drop).

#### TV path

Picking **TV show** opens a modal with four fields:

| Field | Required | Notes |
| --- | --- | --- |
| `Show name` | Yes | Best guess; max 200 chars. |
| `Season number` | Yes | Whole non-negative integer. |
| `Episode number` | Yes | Whole non-negative integer. |
| `The line you want` | Yes | The quote, as best as you remember it. Max 500 chars. |

Both Season and Episode are required - a `Season-blank means fan out` mode is intentionally **not** supported in V1; if the user can't recall both, the request is rejected with an explanatory message.

On submit:

1. The bot looks up the show in Sonarr (TVDB-backed search) and picks the best candidate.
2. If the series isn't already in Sonarr, the bot adds it **unmonitored at the show level** with `addOptions.monitor: "none"`. This is the "add but don't grab the whole show" pattern - we want the parent series record so we can selectively grab a single episode.
3. The targeted episode is flipped to `monitored: true` and an `EpisodeSearch` command is queued. If the episode already has a file on disk, the search is skipped.
4. A row is persisted in `quote_requests` with `acquisition_kind='sonarr'` and the Sonarr **episode** id (not series id) so the reconciler can poll exactly the episode the user asked for.
5. The reconciler polls Sonarr's episode endpoint each tick. Once `hasFile=true`, it advances the row to `imported`, triggers a Jellyfin library refresh, and marks `indexed`. The FTS-match pass on subsequent ticks then runs the same render-and-post fulfillment described above.

If `SONARR_URL`/`SONARR_API_KEY` are unset, the TV path falls back to a passive watch-and-notify mode (no acquisition, just notifies if the quote later appears from a manual SRT or library scan).

#### Refusals (apply to both paths)

- **Low disk space.** Refused if the chosen Radarr/Sonarr root folder has less than the corresponding `*_MIN_FREE_GB` (default 3 GB) free.
- **No candidates.** Radarr or Sonarr's metadata lookup returned nothing for the title; user must retry with a more specific query.
- **Already added.** Movie path: falls back to passive watch against the existing Radarr movie. TV path: skips the add and only monitors+searches the requested episode.
- **Pending cap.** Each user can have up to 10 pending requests at once across both paths.

## `/supercut`

Concatenate every clip of a phrase from a single series into one supercut video. Useful for the obvious meme cases ("MAWP" in Archer, "Bazinga" in Big Bang Theory) but limited by hard caps so it can't melt the box.

### Options

| Option | Required | Type | Notes |
| --- | --- | --- | --- |
| `phrase` | Yes | String | The phrase to find. Must be at least 3 characters. |
| `series` | Yes | Autocomplete string | The series title (case insensitive). Required to keep results coherent for short common phrases. |
| `max_clips` | No | Integer | Override on the clip count. Defaults to and is clamped at `SUPERCUT_MAX_CLIPS` (30 by default). |

The subtitle index must exist first. Run `make index-subtitles` on the host/container before expecting matches.

### Examples

```text
/supercut phrase:mawp series:Archer
/supercut phrase:engage series:Star Trek: The Next Generation max_clips:10
```

### Caps and limits

| Knob | Default | Env var |
| --- | --- | --- |
| Max clips per supercut | 30 | `SUPERCUT_MAX_CLIPS` |
| Max aggregate runtime | 90s | `SUPERCUT_MAX_DURATION_SECONDS` |
| Padding around each cue | 400ms each side | `SUPERCUT_PADDING_MS` |
| Adjacent-cue merge window | 1500ms | `SUPERCUT_COALESCE_GAP_MS` |
| Final mp4 size cap | 24 MB | `SUPERCUT_MAX_MB` |

Only one supercut can render per guild at a time; concurrent requests are rejected with a "try again in a minute" message. Cues from the same item that are within the coalesce window get merged into a single span so adjacent SRT cues don't render as flickers.

### Failure cases

- fewer than 3 hits after coalesce + caps (use `/quote` instead)
- another supercut is already in flight for this guild
- subtitle index missing or stale
- rendered file above the upload cap
- ffmpeg/Jellyfin stream failure on any clip

## `/subcoverage`

Report how much of your Jellyfin library has subtitles, or check a single movie or TV series.

Data comes from Jellyfin's `HasSubtitles` flag on items in your configured movie and TV libraries. Library-wide reports also compare the `/quote` subtitle index (when present) against Jellyfin subtitled items.

### Options

| Option | Required | Type | Notes |
| --- | --- | --- | --- |
| `kind` | No | Choice | `Library (movies + episodes)` (default), `Movie`, or `TV series` |
| `media` | For movie/series | Autocomplete string | Jellyfin item UUID from search (min 2 characters to search) |

### Examples

```text
/subcoverage
/subcoverage kind:TV series media:Breaking Bad
/subcoverage kind:Movie media:The Matrix
```

### Failure cases

- `kind` is `Movie` or `TV series` but `media` is missing or not a valid autocomplete pick
- Jellyfin unreachable or item not visible to the configured user
- no `/quote` index yet (library report still works; index line explains how to build it)

## `/feature`

Guild feature suggestions with **ranked** prioritization (Pattern A: top-3 select menus, 3/2/1 points).

Requires `FEATURE_SUGGESTIONS_CHANNEL_ID` and `GITHUB_TOKEN`.

### `/feature suggest`

| Option | Required | Notes |
| --- | --- | --- |
| `description` | Yes | Reframed into a GitHub issue for guild ranking (default yes; maintainer triages) |

Posts a card in the suggestions channel and updates the guild leaderboard embed.

### `/feature rank`

Ephemeral 3-step select flow: pick **#1**, **#2**, **#3** priorities from open suggestions. Re-run anytime to change your ranks.

### `/feature choose` (maintainer)

| Option | Required | Notes |
| --- | --- | --- |
| `issue` | Yes | Autocomplete of open guild suggestions |

Allowed Discord users: `FEATURE_TRIAGE_DISCORD_USER_IDS` (default: Radgey; prod also includes HeavyGee and Ariabel). Adds GitHub labels `discord-triage-blessed` + `ai-safe` to start Cursor triage without manual GitHub labeling. Warns if the GitHub issue is already closed.

### `/feature status` (maintainer)

| Option | Required | Notes |
| --- | --- | --- |
| `issue` | No | GitHub issue number; omit to list all **building** suggestions |

Shows pipeline checklist and **blocker** (e.g. branch pushed but no PR, CI failed, issue closed). Backed by GitHub inspection plus SQLite `feature_pipeline_events`. See [Issue to deployment](ISSUE_TO_DEPLOYMENT.md#pipeline-observability-85).
