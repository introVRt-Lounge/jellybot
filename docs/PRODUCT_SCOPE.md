# Jellybot product scope

Canonical scope for automated PR review (`scope-review` check) and human triage.

## Mission

Help **every member of a Discord guild** get **maximum practical value** from a **large personal or shared Jellyfin library** — movies, TV, music, and any other item types Jellyfin exposes — without leaving Discord.

The north star is **use Jellyfin to max effect**: if the media (or metadata) lives in Jellyfin and guild members can discover, clip, or share it in Discord, it is generally in scope.

## In scope

Changes that directly support:

- **Finding library items** — search, autocomplete, titles, seasons/episodes, artists/albums/tracks, or other Jellyfin item types
- **Clipping moments** — timestamps, duration, preview before post, upload limits; any Jellyfin item Jellyfin can stream and ffmpeg can slice for Discord
- **Timed text search** — subtitles, lyrics, captions, or equivalent timed metadata → quote-to-clip, padding/duration (same pattern as `/quote` today)
- **Watchability** — audio track selection, subtitle/lyrics burn-in where applicable, Discord-friendly encodes
- **Library coverage** — indexing (subtitles, lyrics, or other text sources Jellyfin provides), incremental index, health of index data
- **Guild UX** — slash commands, ephemeral previews, buttons/modals for clip approval
- **Reliability** — bot health, Jellyfin auth, error messages operators can act on
- **Ship path for this bot** — CI, Docker/GHCR, Watchtower deploy, release announce **for jellybot only**
- **Operator docs** — commands, setup, development, security for this repo

## Out of scope (reject or flag)

- Features **not grounded in Jellyfin** (external lyrics APIs, Spotify, etc.) unless they only fill gaps Jellyfin cannot supply and the PR justifies why
- Unrelated products (other bots, unrelated web apps, generic infra unrelated to jellybot)
- Features that bypass guild members (admin-only power tools with no member benefit)
- Unrelated AI/chat bot behavior, moderation, ticketing, or general-purpose Discord utilities
- Serving or hosting media **outside** the Jellyfin → clip → Discord path
- Broad refactors with no user-visible or operational benefit to the mission above
- Secrets, auth, or deployment patterns copied from other projects without jellybot need

## Quality bar

- Behavior covered by tests when logic changes (or explicit reason in PR)
- No secrets in diff; no logging tokens or credentials
- Smallest change that meets the linked issue or PR summary
- Command/schema changes update `docs/COMMANDS.md` and registration path

## Feature suggestions (`/feature suggest`)

Discord suggestions use a **consideration-first** gate:

- **Default yes** — ideas enter the guild ranking queue unless obviously spam
- **In consideration** — media features, bot meta/tooling, transparency (subtitle coverage, index health), UX, reliability, docs
- **Maintainer triage** — Radgey (or configured triage users) blesses via `/feature choose`; that is the real scope arbiter, not the automated enricher
- **Automated gate** — reframes vague text and expands a GitHub issue sketch; it does not replace human triage

## Review verdict contract

The `scope-review` check passes when the change is **in scope** and **acceptable quality** with **no critical issues**. Important issues may pass only if explicitly justified in the PR and tied to the mission.

When judging scope: ask **“Does this help guild members discover or share something from Jellyfin in Discord?”** If yes, lean pass. If it expands Jellyfin item types (e.g. music lyrics), that is in scope when it follows the same discover → clip → share pattern.
