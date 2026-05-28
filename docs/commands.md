# Commands

See the full contract in the repository: [docs/COMMANDS.md](https://github.com/introVRt-Lounge/jellybot/blob/main/docs/COMMANDS.md).

## `/clip`

Create a Jellyfin clip and upload it to the current channel.

Required at runtime: `kind`, `media`, `start`, and either `end` or `duration`.

## `/quote`

Search indexed subtitles and clip the scene around a matched quote.

Requires a built subtitle index (`make index-subtitles`).

## `/subcoverage`

Report Jellyfin subtitle coverage library-wide or for a movie or TV series.
