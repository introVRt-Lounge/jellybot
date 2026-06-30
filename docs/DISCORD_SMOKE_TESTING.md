# Discord user-token smoke testing (jellybot)

**Full dev-bot smoke suite:** [SMOKE.md](SMOKE.md) (`make smoke`, `make smoke-ci`, GitHub `Smoke` workflow on self-hosted runner).

Optional **individual** live checks using a **dedicated test user account** and the local [`discord.py-self`](../../discord.py-self) checkout.

Skill reference: `discord-user-token-smoke-testing` (`~/coding/skills/discord-user-token-smoke-testing/SKILL.md`).

## Prerequisites

| Requirement | Where |
|-------------|--------|
| `discord.py-self` checkout | `DISCORD_PY_SELF_ROOT=~/coding/discord.py-self` |
| User token (throwaway test account) | `~/coding/discord.py-self/.env` → `DISCORD_USER_TOKEN` |
| Test channel | `DISCORD_TEST_CHANNEL_ID` in `discord.py-self/.env` |
| Bot application id | `jellybot/.env` → `DISCORD_CLIENT_ID` |
| Running prod (or dev) bot | default log source: `docker logs jellybot-dev` (override `JELLYBOT_SMOKE_LOG_CMD`) |

## Commands

```bash
export DISCORD_PY_SELF_ROOT=~/coding/discord.py-self

# /quote match autocomplete (log-correlated pass gate)
bun run smoke:discord:quote

# /clip happy path (uses configured JELLYBOT_SMOKE_ITEM_ID)
bun run smoke:discord

# Both
bun run smoke:discord:all

# Log correlation unit tests (offline)
python3 scripts/test_discord_smoke_support.py
```

Makefile equivalents: `make smoke-discord-quote`, `make smoke-discord`, `make smoke-discord-all`.

## Pass criteria: `/quote` autocomplete

The user client (`discord.py-self`) often reports `client_choices=0` even when the bot responded correctly. **Do not use client choices as the pass gate.**

Authoritative check (implemented in `scripts/discord_smoke_support.py`):

1. Fire `APPLICATION_COMMAND_AUTOCOMPLETE` for `/quote` option `match` from the test channel.
2. Read structured bot logs (`JELLYBOT_SMOKE_LOG_CMD`, default `docker logs jellybot`).
3. **Pass** when logs contain, in order:
   - `quote.autocomplete` with matching `interactionId` + `query`
   - `quote.autocomplete.responded` with `responded: true` and `resultCount > 0`
4. **Fail** on `quote.autocomplete.respond_skipped` / `respond_skip` / `autocomplete_failed`, or missing outcome.

Override query: `JELLYBOT_SMOKE_QUOTE_QUERY=looking`.

docs/DISCORD_SMOKE_TESTING.md

## When agents should run this

After changing quote autocomplete, Discord gateway, or deploy verification:

1. `bun run ci` (required)
2. `bun run smoke:discord:quote` when prod bot is up and credentials exist
3. Treat failure + green CI as gateway/token/duplicate-bot ops issue until logs prove otherwise

## Policy

- User-token automation violates Discord ToS — dedicated test account only.
- Never commit tokens.
- Do not run `bun run start` from dev with the **production** bot token (duplicate gateway risk). See issue #60.
