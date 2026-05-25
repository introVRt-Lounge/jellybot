# Commands

## `/clip`

Create a Jellyfin clip and upload it to the current channel.

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

### Permissions

The bot needs Send Messages and Attach Files in the target channel.

### Manual verification after command changes

1. Run `make register-commands` or the compose register profile
2. In Discord, pick `kind`, then type at least 2 characters in `media`
3. Confirm autocomplete returns compact labels within 3 seconds
4. Run one happy-path clip and one validation failure

## `/quote`

Search indexed subtitles and clip the scene around a matched quote.

### Options

| Option | Required at runtime | Type | Notes |
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
