# Jellybot product scope

Canonical scope for automated PR review (`scope-review` check) and human triage.

## Mission

Help **every member of a Discord guild** make effective use of a **large personal or shared Jellyfin video library** without leaving Discord.

## In scope

Changes that directly support:

- **Finding media** — search, autocomplete, titles, TV season/episode selection
- **Clipping scenes** — timestamps, duration, preview before post, upload limits
- **Quotes from subtitles** — indexed subtitle search, quote-to-clip, padding/duration
- **Watchability** — audio track selection, subtitle burn-in, Discord-friendly encodes
- **Library coverage** — subtitle indexing, incremental index, health of index data
- **Guild UX** — slash commands, ephemeral previews, buttons/modals for clip approval
- **Reliability** — bot health, Jellyfin auth, error messages operators can act on
- **Ship path for this bot** — CI, Docker/GHCR, Watchtower deploy, release announce **for jellybot only**
- **Operator docs** — commands, setup, development, security for this repo

## Out of scope (reject or flag)

- Unrelated products (other bots, unrelated web apps, generic infra unrelated to jellybot)
- Features that bypass guild members (admin-only power tools with no member benefit)
- Unrelated AI/chat bot behavior, moderation, ticketing, or general-purpose Discord utilities
- Storing or serving media outside the Jellyfin → clip → Discord path
- Broad refactors with no user-visible or operational benefit to the mission above
- Secrets, auth, or deployment patterns copied from other projects without jellybot need

## Quality bar

- Behavior covered by tests when logic changes (or explicit reason in PR)
- No secrets in diff; no logging tokens or credentials
- Smallest change that meets the linked issue or PR summary
- Command/schema changes update `docs/COMMANDS.md` and registration path

## Review verdict contract

The `scope-review` check passes when the change is **in scope** and **acceptable quality** with **no critical issues**. Important issues may pass only if explicitly justified in the PR and tied to the mission.
