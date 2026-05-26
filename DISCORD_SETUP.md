# Discord setup for Jellybot

## Application

- Developer Portal: https://discord.com/developers/applications
- Application name: your choice (e.g. JellyBot)
- Application ID: value of `DISCORD_CLIENT_ID` in `.env`

## OAuth2 scopes

Required:

- `bot`
- `applications.commands`

## Bot permissions

Minimum permissions for `/clip`:

| Permission | Needed for |
| --- | --- |
| Send Messages | post clip summary text |
| Attach Files | upload rendered MP4 |
| Embed Links | optional rich previews |
| Use Slash Commands | slash command surface |

Generate an invite URL in the Developer Portal OAuth2 URL Generator with the scopes and permissions above. Each bot gets its own client ID and invite link.

Do not grant Administrator unless you explicitly want it.

## Privileged intents

Keep all privileged intents **disabled** unless a future feature needs them.

| Intent | Status |
| --- | --- |
| Presence Intent | Off |
| Server Members Intent | Off |
| Message Content Intent | Off |

Runtime uses only `GatewayIntentBits.Guilds`.

## Command registration

Jellybot uses **guild-scoped** slash commands when `DISCORD_GUILD_ID` or `DISCORD_GUILD_IDS` is set (recommended for dev and prod). Guild sync is instant; global propagation can take up to an hour.

### Guild vs global (critical)

| Mode | When | Global commands |
| --- | --- | --- |
| **Guild** | `DISCORD_GUILD_ID(S)` set | Must be **empty**. Stale globals cause duplicate autocomplete and `Interaction has already been acknowledged`. |
| **Global** | No guild IDs configured | Registered via `Routes.applicationCommands` only |

Registration is a separate one-shot step (`make register-commands`). The running bot also **self-heals on startup**: if guild-scoped and stale globals exist, it clears them automatically.

```bash
bun run register-commands
# or
make register-commands
# or
docker compose --profile register run --rm jellybot-register-commands
```

After any slash command schema change, run `make register-commands` before expecting new options in Discord.

## Verification checklist

1. Bot invite opens with `applications.commands` scope
2. `/clip` appears in the target guild or globally after sync propagation
3. Pick `kind` first, then autocomplete on `media` returns Jellyfin matches
4. Ephemeral validation errors appear for bad timestamps or missing `start`
5. Successful clip uploads an MP4 attachment to the channel
6. `GET /healthz` returns `200` with `"discord":"connected"` once the container is healthy

## Known limits

- Discord autocomplete must respond within 3 seconds
- Autocomplete choice names and values are capped at 100 characters
- Discord upload size depends on server boost tier; non-boosted servers default to **10 MB** for bots
- Jellyfin access follows the configured Jellyfin user (`JELLYFIN_USERNAME`), not admin API keys

## Token hygiene

- Store `DISCORD_TOKEN` only in `.env` or deployment secrets
- Never log the token
- Rotate immediately if the token leaks
