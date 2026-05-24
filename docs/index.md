# Jellybot

<div class="jellybot-hero" markdown="1">
![Jellybot banner](assets/jellybot_banner_680x240.png)
</div>

<p class="jellybot-lede" markdown="1">
Discord slash-command bot for your Jellyfin library: search media, extract clips, and find quotes in indexed subtitles.
</p>

[![CI](https://github.com/introVRt-Lounge/jellybot/actions/workflows/ci.yml/badge.svg)](https://github.com/introVRt-Lounge/jellybot/actions/workflows/ci.yml)
[![GHCR](https://img.shields.io/badge/container-ghcr.io%2Fintrovrt--lounge%2Fjellybot-2496ED?logo=docker&logoColor=white)](https://github.com/introVRt-Lounge/jellybot/pkgs/container/jellybot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/introVRt-Lounge/jellybot/blob/main/LICENSE)

## Why Jellybot?

- **`/clip`** - pull a segment from any movie or TV episode in Jellyfin
- **`/quote`** - search subtitle text and post the matching scene as a clip
- **Self-hosted** - runs beside your Jellyfin stack; no cloud transcoding lock-in
- **Docker-first** - GHCR image, health endpoint, Compose profiles for dev and prod

## Quick start

```bash
git clone https://github.com/introVRt-Lounge/jellybot.git
cd jellybot
cp .env.example .env
bun install
bun run register-commands
bun run start
```

Production image:

```bash
docker pull ghcr.io/introvrt-lounge/jellybot:latest
```

Package page: [ghcr.io/introvrt-lounge/jellybot](https://github.com/introVRt-Lounge/jellybot/pkgs/container/jellybot)

## Learn more

- [Commands](commands.md) - `/clip` and `/quote`
- [Architecture](architecture.md) - stack, data paths, backup
- [Limits](limits.md) - Discord upload and clip constraints
- [GitHub repository](https://github.com/introVRt-Lounge/jellybot) - source, issues, contributing
