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
- free-typed `match` text instead of an autocomplete pick
- clip longer than `MAX_CLIP_SECONDS`
- rendered file above Discord upload limit
- Jellyfin item no longer visible to the configured user

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

Allowed Discord users: `FEATURE_TRIAGE_DISCORD_USER_IDS` (default: Radgey). Adds GitHub labels `discord-triage-blessed` + `ai-safe` to start Cursor triage without manual GitHub labeling.
