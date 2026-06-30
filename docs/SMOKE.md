# Smoke (Discord bot)

**Smoke** = impersonate a real user with `discord.py-self`, fire slash autocomplete against **JellyBot-Dev** in **Bottitesto**, and **fail** if bot logs show a missed Discord response window (`Unknown interaction`, no `quote.autocomplete.responded`).

That catches the prod UX bug class — autocomplete that searches fine but responds too late — **before users do**.

**Not smoke:** `src/cli/smoke-live.ts` (in-container Jellyfin + SQLite). That runs as **preflight** so Discord smoke is not debugging a dead Jellyfin. It never posts to Discord.

## Where it runs

- **Host:** proxmox self-hosted runner (`runs-on: [self-hosted, jellybot-live]`) — **not** GitHub-hosted ubuntu.
- **Ephemeral CI container:** `jellybot-smoke-<run>` on port **8094** (PR image under test). Does not replace long-lived `jellybot-dev` on **8093**.
- **Persistent dev:** `jellybot-dev` on **8093** for manual `make smoke` / `make dev-refresh`.
- **Discord:** smoke user (`DISCORD_USER_TOKEN` in `discord.py-self/.env`) in a **Bottitesto guild channel** (`JELLYBOT_SMOKE_CHANNEL_ID` or `DISCORD_TEST_CHANNEL_ID` — must match `DISCORD_GUILD_ID` in jellybot `.env`)

You should see activity in that channel when extended smoke is on; **required gate** is log-correlated autocomplete (no visible dropdown in channel — the user client fires autocomplete programmatically).

## Required gate (CI)

- **`/quote` `match` autocomplete** — log must show `quote.autocomplete` then `quote.autocomplete.responded` with `resultCount > 0`
- **`/quote` `series` autocomplete** — same for `quote.series_autocomplete`

Fail messages call out **Unknown interaction** explicitly (Discord 3s autocomplete window).

## Why Discord is painful to test

Discord does **not** ship a supported way to E2E-test gateway bots (real `INTERACTION_CREATE` → `interaction.respond()` under the 3s autocomplete deadline). Official options are:

- **Unit mocks** (fake `AutocompleteInteraction`, assert `respond()` was called) — fast, not real.
- **REST mocks** (e.g. fauxcord) — HTTP-only; jellybot uses the **gateway**, not an interactions HTTP endpoint.
- **User-token clients** (`discord.py-self`) — same `/interactions` path the desktop app uses. This is what smoke uses.

If smoke passes on the selfbot path, you have a reproducible pre-prod gate that mirrors what users hit. If it fails, read the message: **missing logs** often means the dev bot event loop was wedged; **Unknown interaction** is the prod bug class.

## Smoke harness gotchas (fixed)

- **Log correlation** uses `docker logs --since` (not line counts) so buffered container output is not missed.
- **Default queries** are `arrested` / `Simp` — avoid `the` on a 9M-cue FTS index (slow enough to miss the 3s window).
- **CI recreates** an ephemeral `jellybot-smoke-<run>` on **8094** with `SUBTITLE_INDEX_ON_STARTUP=off` — leaves long-lived `jellybot-dev` on **8093** alone.
- **Health must answer in &lt;2s** before each attempt; if not, check the ephemeral container logs (`docker logs jellybot-smoke-<run>`).

Tune with `JELLYBOT_SMOKE_LOG_POLL_SEC` (default 45), `JELLYBOT_SMOKE_RETRY_COUNT` (default 2).

## Commands

```bash
make smoke-ci          # preflight + Discord smoke (CI)
make smoke             # Discord smoke only (dev bot must be up on :8093)
make smoke-discord-quote   # single /quote match check
```

Extended slash checks (`/clip`, `/supercut`, …): `JELLYBOT_SMOKE_EXTENDED=1 make smoke`.

## Host networking (self-hosted only)

CI symlinks `~/coding/jellybot-dev/docker-compose.override.yml` when present (typically `traefik_net` + `JELLYFIN_URL=http://jellyfin:8096`) so the ephemeral smoke container reaches Jellyfin the same way as persistent `jellybot-dev`.

## Credentials

Host files only — no GitHub Secrets:

- `~/coding/jellybot-dev/.env` — JellyBot-Dev token, `DISCORD_GUILD_ID` (Bottitesto)
- `~/coding/discord.py-self/.env` — smoke user token + test channel

Runbook: `~/coding/server-setup/docs/runbooks/github-self-hosted-runners.md`
