# Commands

## `/clip`

Create a Jellyfin clip and upload it to the current channel.

### Options

| Option | Required at runtime | Type | Notes |
| --- | --- | --- | --- |
| `kind` | Yes | Choice | `Movie` or `TV episode` |
| `media` | Yes | Autocomplete string | Jellyfin item UUID |
| `start` | Yes | String | Timestamp such as `90`, `1:30`, `01:02:03` |
| `end` | One of end/duration | String | Absolute end timestamp |
| `duration` | One of end/duration | String | Length from `start` |

`start` is optional in the Discord command schema so autocomplete on `media` works while later options are still empty. The bot rejects the command if `start` is missing.

### Examples

```text
/clip kind:Movie media:The Matrix start:1:23:45 duration:30
/clip kind:TV episode media:Breaking Bad S01E01 start:90 end:2:30
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
- ffmpeg/Jellyfin stream failure

### Permissions

The bot needs Send Messages and Attach Files in the target channel.

### Manual verification after command changes

1. Run `make register-commands` or the compose register profile
2. In Discord, pick `kind`, then type at least 2 characters in `media`
3. Confirm autocomplete returns compact labels within 3 seconds
4. Run one happy-path clip and one validation failure
