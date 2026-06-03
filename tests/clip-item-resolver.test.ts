import { describe, expect, test } from "bun:test";
import type { JellyfinClient, JellyfinItem } from "../src/jellyfin.ts";
import type { IndexedMediaItem, SubtitleIndex } from "../src/subtitles/index-db.ts";
import { resolveClipItem } from "../src/services/clip-item-resolver.ts";

// Issue #118: when a Jellyfin item id stored in our subtitle index is no
// longer reachable (file replace -> Jellyfin reissues a new internal id),
// the clip pipeline should recover by re-locating the item via stable
// metadata (title+year for movies, series+S/E for episodes).

const MOVIE_ITEM: JellyfinItem = {
  id: "new-movie-id",
  type: "Movie",
  name: "In Bruges",
  productionYear: 2008,
  runtimeTicks: 36_000_000_000,
  mediaSources: [],
} as unknown as JellyfinItem;

const EPISODE_ITEM: JellyfinItem = {
  id: "new-episode-id",
  type: "Episode",
  name: "Cunning Plans",
  seriesName: "Blackadder",
  seasonNumber: 1,
  episodeNumber: 1,
  runtimeTicks: 18_000_000_000,
  mediaSources: [],
} as unknown as JellyfinItem;

function makeIndex(items: Record<string, IndexedMediaItem | null>): SubtitleIndex {
  const fake: Partial<SubtitleIndex> = {
    getMediaItem: (id: string) => items[id] ?? null,
  };
  return fake as SubtitleIndex;
}

function makeJellyfin(overrides: Partial<JellyfinClient>): JellyfinClient {
  const base: Partial<JellyfinClient> = {
    getItem: async () => null,
    findMovieByTitle: async () => null,
    findEpisodeBySeriesTitleAndNumbers: async () => null,
  };
  return { ...base, ...overrides } as JellyfinClient;
}

describe("resolveClipItem (#118)", () => {
  test("returns the item directly when getItem succeeds", async () => {
    const jellyfin = makeJellyfin({
      getItem: async (id) => (id === "live-id" ? MOVIE_ITEM : null),
    });
    const subtitleIndex = makeIndex({});

    const result = await resolveClipItem({ jellyfin, subtitleIndex, itemId: "live-id" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item).toBe(MOVIE_ITEM);
    expect(result.recovered).toBe(false);
    expect(result.previousItemId).toBeUndefined();
  });

  test("recovers a stale movie id via subtitle index metadata", async () => {
    const findMovieCalls: Array<{ title: string; year?: number }> = [];
    const jellyfin = makeJellyfin({
      getItem: async () => null,
      findMovieByTitle: async (title, year) => {
        findMovieCalls.push({ title, year });
        return MOVIE_ITEM;
      },
    });
    const subtitleIndex = makeIndex({
      "stale-movie-id": {
        itemId: "stale-movie-id",
        itemType: "Movie",
        title: "In Bruges",
        productionYear: 2008,
        mediaSourceId: "src",
        subtitleIndex: 0,
      },
    });

    const result = await resolveClipItem({
      jellyfin,
      subtitleIndex,
      itemId: "stale-movie-id",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.id).toBe("new-movie-id");
    expect(result.recovered).toBe(true);
    expect(result.previousItemId).toBe("stale-movie-id");
    expect(findMovieCalls).toEqual([{ title: "In Bruges", year: 2008 }]);
  });

  test("recovers a stale episode id via series + S/E", async () => {
    const seriesCalls: Array<{ title: string; s: number; e: number }> = [];
    const jellyfin = makeJellyfin({
      getItem: async () => null,
      findEpisodeBySeriesTitleAndNumbers: async (title, s, e) => {
        seriesCalls.push({ title, s, e });
        return EPISODE_ITEM;
      },
    });
    const subtitleIndex = makeIndex({
      "stale-ep-id": {
        itemId: "stale-ep-id",
        itemType: "Episode",
        title: "Cunning Plans",
        seriesName: "Blackadder",
        seasonNumber: 1,
        episodeNumber: 1,
        mediaSourceId: "src",
        subtitleIndex: 0,
      },
    });

    const result = await resolveClipItem({
      jellyfin,
      subtitleIndex,
      itemId: "stale-ep-id",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.id).toBe("new-episode-id");
    expect(result.recovered).toBe(true);
    expect(seriesCalls).toEqual([{ title: "Blackadder", s: 1, e: 1 }]);
  });

  test("returns ok=false when the indexed metadata is missing", async () => {
    const jellyfin = makeJellyfin({});
    const subtitleIndex = makeIndex({});
    const result = await resolveClipItem({
      jellyfin,
      subtitleIndex,
      itemId: "ghost-id",
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok=false when re-search returns null", async () => {
    const jellyfin = makeJellyfin({
      getItem: async () => null,
      findMovieByTitle: async () => null,
    });
    const subtitleIndex = makeIndex({
      "stale-movie-id": {
        itemId: "stale-movie-id",
        itemType: "Movie",
        title: "Obscure Direct-to-VHS Title",
        mediaSourceId: "src",
        subtitleIndex: 0,
      },
    });
    const result = await resolveClipItem({
      jellyfin,
      subtitleIndex,
      itemId: "stale-movie-id",
    });
    expect(result.ok).toBe(false);
  });

  test("survives transient getItem rejection without throwing", async () => {
    const jellyfin = makeJellyfin({
      getItem: async () => {
        throw new Error("network blip");
      },
      findMovieByTitle: async () => MOVIE_ITEM,
    });
    const subtitleIndex = makeIndex({
      "stale-movie-id": {
        itemId: "stale-movie-id",
        itemType: "Movie",
        title: "In Bruges",
        productionYear: 2008,
        mediaSourceId: "src",
        subtitleIndex: 0,
      },
    });

    const result = await resolveClipItem({
      jellyfin,
      subtitleIndex,
      itemId: "stale-movie-id",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recovered).toBe(true);
  });

  test("falls back to ok=false when subtitle index is null (caller didn't open it)", async () => {
    const jellyfin = makeJellyfin({});
    const result = await resolveClipItem({
      jellyfin,
      subtitleIndex: null,
      itemId: "anything",
    });
    expect(result.ok).toBe(false);
  });
});
