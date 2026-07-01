import "dotenv/config";
import { searchClipMediaAutocompleteChoices } from "../clip-autocomplete.ts";
import { loadConfig } from "../config.ts";
import { JellyfinClient } from "../jellyfin.ts";
import { planClipRequest } from "../services/clip-request.ts";
import { buildLibrarySubtitleCoverage } from "../services/subtitle-coverage.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import { getSubtitleSearchIndex } from "../subtitles/search-index.ts";

type SmokeCheck = {
  name: string;
  run: () => Promise<void>;
};

const config = loadConfig();
const quoteQuery = process.env.JELLYBOT_SMOKE_QUOTE_QUERY?.trim() || "the";
const seriesQuery = process.env.JELLYBOT_SMOKE_SERIES_QUERY?.trim() || "Red";
const clipMediaQuery = process.env.JELLYBOT_SMOKE_CLIP_MEDIA_QUERY?.trim() || "Red";
const clipItemId =
  process.env.JELLYBOT_SMOKE_ITEM_ID?.trim() || "6ef4f7234b7793e6788f1bf9ccc19b70";

const jellyfin = new JellyfinClient(
  config.jellyfinUrl,
  config.jellyfinUsername,
  config.jellyfinPassword,
  config.jellyfinMoviesLibraryId,
  config.jellyfinTvLibraryId,
);

const checks: SmokeCheck[] = [
  {
    name: "jellyfin.authenticate",
    run: async () => {
      await jellyfin.authenticate();
    },
  },
  {
    name: "subtitle_index.stats",
    run: async () => {
      const index = openSubtitleIndex(config.subtitleDbPath, { readonly: true });
      try {
        const stats = index.getStats();
        if (stats.itemCount < 1 || stats.cueCount < 1) {
          throw new Error(`empty subtitle index: ${JSON.stringify(stats)}`);
        }
        console.info(JSON.stringify({ event: "smoke.subtitle_index", ...stats }));
      } finally {
        index.close();
      }
    },
  },
  {
    name: "quote.match_search",
    run: async () => {
      const index = getSubtitleSearchIndex(config.subtitleDbPath);
      const results = index.searchQuotes(quoteQuery, 10);
      if (results.length < 1) {
        throw new Error(`no quote matches for query=${quoteQuery}`);
      }
      console.info(
        JSON.stringify({
          event: "smoke.quote.match_search",
          query: quoteQuery,
          resultCount: results.length,
        }),
      );
    },
  },
  {
    name: "quote.series_search",
    run: async () => {
      const index = getSubtitleSearchIndex(config.subtitleDbPath);
      const names = index.listSeriesNames(seriesQuery, 10);
      if (names.length < 1) {
        throw new Error(`no series names for query=${seriesQuery}`);
      }
      console.info(
        JSON.stringify({
          event: "smoke.quote.series_search",
          query: seriesQuery,
          resultCount: names.length,
        }),
      );
    },
  },
  {
    name: "clip.jellyfin_search",
    run: async () => {
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await jellyfin.authenticate();
          const choices = await searchClipMediaAutocompleteChoices(jellyfin, clipMediaQuery, "tv");
          if (choices.length < 1) {
            throw new Error(`no clip media choices for query=${clipMediaQuery}`);
          }
          console.info(
            JSON.stringify({
              event: "smoke.clip.jellyfin_search",
              query: clipMediaQuery,
              resultCount: choices.length,
              attempt,
            }),
          );
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      throw lastError ?? new Error("clip jellyfin search failed");
    },
  },
  {
    name: "clip.plan",
    run: async () => {
      const planned = planClipRequest({
        kind: "tv",
        itemId: clipItemId,
        startRaw: "1:00",
        durationRaw: "8s",
        maxClipSeconds: config.maxClipSeconds,
      });
      if (!planned.ok) {
        throw new Error(planned.message);
      }
      console.info(JSON.stringify({ event: "smoke.clip.plan", plan: planned.plan }));
    },
  },
  {
    name: "subcoverage.library",
    run: async () => {
      const index = openSubtitleIndex(config.subtitleDbPath, { readonly: true });
      let stats;
      try {
        stats = index.getStats();
      } finally {
        index.close();
      }
      const report = await buildLibrarySubtitleCoverage(jellyfin, stats);
      if (report.kind !== "library" || report.movies.total + report.episodes.total < 1) {
        throw new Error("library coverage report empty");
      }
      console.info(
        JSON.stringify({
          event: "smoke.subcoverage.library",
          moviesTotal: report.movies.total,
          episodesTotal: report.episodes.total,
          quoteIndexItems: report.quoteIndex?.itemCount ?? 0,
        }),
      );
    },
  },
];

const failures: string[] = [];

for (const check of checks) {
  process.stdout.write(`[smoke] ${check.name} … `);
  try {
    await check.run();
    console.log("OK");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("FAIL");
    failures.push(`${check.name}: ${message}`);
  }
}

if (failures.length > 0) {
  console.error("\n=== smoke-live FAILED ===");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.info("\n=== smoke-live PASSED ===");
