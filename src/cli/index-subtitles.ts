import "dotenv/config";
import { JellyfinClient } from "../jellyfin.ts";
import { loadConfig } from "../config.ts";
import { indexSubtitles } from "../subtitles/indexer.ts";
import { parsePreferredLanguages } from "../subtitles/track-select.ts";

const config = loadConfig();
const incremental = process.argv.includes("--incremental");
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinUsername, config.jellyfinPassword);

await jellyfin.authenticate();
console.info(
  JSON.stringify({
    event: "subtitle_index.start",
    dbPath: config.subtitleDbPath,
    incremental,
    concurrency: config.subtitleIndexConcurrency,
  }),
);

const summary = await indexSubtitles(jellyfin, {
  dbPath: config.subtitleDbPath,
  preferredLanguages: parsePreferredLanguages(config.subtitleLanguages),
  concurrency: config.subtitleIndexConcurrency,
  incremental,
  onProgress(event) {
    console.info(JSON.stringify({ event: "subtitle_index.progress", ...event }));
  },
});

console.info(JSON.stringify({ event: "subtitle_index.done", summary }));

if (summary.errors > 0) {
  process.exitCode = 1;
}
