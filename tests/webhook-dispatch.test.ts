import { describe, expect, test } from "bun:test";
import { WebhookDispatcher, type DispatchConfig } from "../src/webhooks/dispatch.ts";
import type { JellyfinClient, JellyfinItem } from "../src/jellyfin.ts";
import type { WebhookKick } from "../src/webhooks/types.ts";

type IndexerCall = { itemId: string };

function makeDeps(opts: {
  config?: Partial<DispatchConfig>;
  findItemByTmdbId?: (id: number) => Promise<JellyfinItem | null>;
  findEpisodeByTvdb?: (tvdbId: number, s: number, e: number) => Promise<JellyfinItem | null>;
  triggerLibraryRefresh?: () => Promise<void>;
  refreshItem?: (id: string) => Promise<void>;
  indexer?: (j: JellyfinClient, o: { itemId: string }) => Promise<{ ok: true; itemId: string; cueCount: number } | { ok: false; itemId: string; reason: "missing" | "no_cues" | "error"; message?: string }>;
}) {
  const indexerCalls: IndexerCall[] = [];
  const refreshItemCalls: string[] = [];
  let libraryRefreshCount = 0;

  const jellyfin = {
    findItemByTmdbId: opts.findItemByTmdbId ?? (async () => null),
    findEpisodeByTvdb: opts.findEpisodeByTvdb ?? (async () => null),
    triggerLibraryRefresh:
      opts.triggerLibraryRefresh ??
      (async () => {
        libraryRefreshCount += 1;
      }),
    refreshItem:
      opts.refreshItem ??
      (async (id: string) => {
        refreshItemCalls.push(id);
      }),
  } as unknown as JellyfinClient;

  // Real timers + tiny intervals - mocking sleep is incompatible with letting
  // the real setTimeout-driven debounce fire, leading to busy loops in drain.
  const dispatcher = new WebhookDispatcher({
    jellyfin,
    config: {
      subtitleDbPath: ":memory:",
      preferredLanguages: ["eng", "en"],
      debounceMs: 5,
      pollMaxAttempts: 3,
      pollIntervalMs: 2,
      postRefreshSettleMs: 0,
      ...opts.config,
    },
    indexer:
      opts.indexer ??
      (async (_j, o) => {
        indexerCalls.push({ itemId: o.itemId });
        return { ok: true, itemId: o.itemId, cueCount: 100 };
      }),
  });

  return {
    dispatcher,
    indexerCalls,
    refreshItemCalls,
    get libraryRefreshCount() {
      return libraryRefreshCount;
    },
  };
}

const movieKick: WebhookKick = {
  kind: "movie",
  source: "radarr",
  eventType: "Download",
  tmdbId: 583,
  title: "Life of Brian",
};

const episodeKick: WebhookKick = {
  kind: "episode",
  source: "sonarr",
  eventType: "Download",
  tvdbId: 70327,
  seasonNumber: 2,
  episodeNumber: 5,
  title: "Buffy",
};

describe("WebhookDispatcher", () => {
  test("happy path: refresh library + lookup + refresh item + index", async () => {
    const movie: JellyfinItem = { id: "lob-id", name: "Life of Brian", type: "Movie" };
    const fixture = makeDeps({
      findItemByTmdbId: async () => movie,
    });

    fixture.dispatcher.enqueue(movieKick);
    await fixture.dispatcher.drain();

    expect(fixture.libraryRefreshCount).toBe(1);
    expect(fixture.refreshItemCalls).toEqual(["lob-id"]);
    expect(fixture.indexerCalls).toEqual([{ itemId: "lob-id" }]);
  });

  test("coalesces multiple kicks for the same key into a single index run", async () => {
    const movie: JellyfinItem = { id: "lob-id", name: "Life of Brian", type: "Movie" };
    const fixture = makeDeps({
      findItemByTmdbId: async () => movie,
    });

    fixture.dispatcher.enqueue(movieKick);
    fixture.dispatcher.enqueue(movieKick);
    fixture.dispatcher.enqueue(movieKick);
    await fixture.dispatcher.drain();

    expect(fixture.indexerCalls).toEqual([{ itemId: "lob-id" }]);
    expect(fixture.libraryRefreshCount).toBe(1);
  });

  test("does not coalesce kicks for different items", async () => {
    const fixture = makeDeps({
      findItemByTmdbId: async () => ({ id: "lob-id", name: "Life of Brian", type: "Movie" }),
      findEpisodeByTvdb: async () => ({
        id: "ep-id",
        name: "Reptile Boy",
        type: "Episode",
        seasonNumber: 2,
        episodeNumber: 5,
      }),
    });

    fixture.dispatcher.enqueue(movieKick);
    fixture.dispatcher.enqueue(episodeKick);
    await fixture.dispatcher.drain();

    expect(fixture.indexerCalls.map((c) => c.itemId).sort()).toEqual(["ep-id", "lob-id"]);
  });

  test("polls for the item when Jellyfin lags behind the webhook", async () => {
    let lookupAttempts = 0;
    const fixture = makeDeps({
      findItemByTmdbId: async () => {
        lookupAttempts += 1;
        return lookupAttempts >= 3 ? { id: "ok", name: "x", type: "Movie" } : null;
      },
    });

    fixture.dispatcher.enqueue(movieKick);
    await fixture.dispatcher.drain();

    expect(lookupAttempts).toBe(3);
    expect(fixture.indexerCalls).toEqual([{ itemId: "ok" }]);
  });

  test("gives up cleanly when the item never appears in Jellyfin", async () => {
    const fixture = makeDeps({
      findItemByTmdbId: async () => null,
    });

    fixture.dispatcher.enqueue(movieKick);
    await fixture.dispatcher.drain();

    expect(fixture.indexerCalls).toEqual([]);
    expect(fixture.refreshItemCalls).toEqual([]);
  });

  test("indexes through even if the per-item refresh call fails (Bazarr-only flows)", async () => {
    const movie: JellyfinItem = { id: "lob-id", name: "Life of Brian", type: "Movie" };
    const fixture = makeDeps({
      findItemByTmdbId: async () => movie,
      refreshItem: async () => {
        throw new Error("Jellyfin item refresh failed (500).");
      },
    });

    fixture.dispatcher.enqueue(movieKick);
    await fixture.dispatcher.drain();

    expect(fixture.indexerCalls).toEqual([{ itemId: "lob-id" }]);
  });

  test("logs but doesn't throw when the indexer call returns a failure result", async () => {
    const movie: JellyfinItem = { id: "lob-id", name: "Life of Brian", type: "Movie" };
    const fixture = makeDeps({
      findItemByTmdbId: async () => movie,
      indexer: async () => ({ ok: false, itemId: "lob-id", reason: "no_cues" }),
    });

    fixture.dispatcher.enqueue(movieKick);
    await fixture.dispatcher.drain();
    // Drain returns - no unhandled rejection. The dispatcher already logged.
    expect(true).toBe(true);
  });
});
