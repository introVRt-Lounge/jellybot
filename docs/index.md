# Jellybot

Discord slash command bot that searches your Jellyfin library and posts video clips back to the channel.

## Quick start

```bash
git clone https://github.com/introVRt-Lounge/jellybot.git
cd jellybot
cp .env.example .env
bun install
bun run register-commands
bun run start
```

Production Docker image:

```bash
docker pull ghcr.io/introvrt-lounge/jellybot:latest
```

Package page: [ghcr.io/introvrt-lounge/jellybot](https://github.com/introVRt-Lounge/jellybot/pkgs/container/jellybot)

## Commands

- `/clip` - extract a segment from a movie or TV episode
- `/quote` - search indexed subtitles and clip the matching scene

See [Commands](commands.md) and the repository [DISCORD_SETUP.md](https://github.com/introVRt-Lounge/jellybot/blob/main/DISCORD_SETUP.md).
