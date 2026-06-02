import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQuoteRequestReconcile } from "../src/quote-requests/reconciler.ts";
import { QuoteRequestStore } from "../src/quote-requests/store.ts";

function patchFetch(handler: (url: string, init: RequestInit) => Response): () => void {
  const original = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
  return () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFakeClient() {
  return {
    client: {
      channels: {
        async fetch() {
          return {
            isTextBased: () => true,
            isDMBased: () => false,
            async send() {
              return { id: "msg" };
            },
          };
        },
      },
    } as unknown as { channels: { fetch(id: string): Promise<unknown> } },
  };
}

function makeFakeJellyfin() {
  const calls = { triggerLibraryRefresh: 0 };
  return {
    calls,
    jellyfin: {
      findItemByTmdbId: async () => null,
      triggerLibraryRefresh: async () => {
        calls.triggerLibraryRefresh += 1;
      },
    },
  };
}

describe("Sonarr reconciler poll path", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try {
        unlinkSync(p);
      } catch {
        // ignore
      }
    }
  });

  function tmpPath(prefix: string): string {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    return path;
  }

  test("when Sonarr reports hasFile=true, marks imported then advances to indexed and triggers a Jellyfin refresh", async () => {
    const restore = patchFetch((url) => {
      if (url.includes("/api/v3/episode/22")) {
        return jsonResponse({
          id: 22,
          seriesId: 99,
          seasonNumber: 2,
          episodeNumber: 5,
          monitored: true,
          hasFile: true,
          episodeFileId: 1234,
        });
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const botStateDbPath = tmpPath("qr-tv-state");
      const subtitleDbPath = tmpPath("qr-tv-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Buffy",
        quoteText: "fictional quote",
        acquisitionKind: "sonarr",
        acquisitionExternalId: 22,
        acquisitionStatus: "searching",
        acquisitionMetadata: JSON.stringify({ tvdbId: 70327, seriesId: 99 }),
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin();

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          sonarrUrl: "http://sonarr/sonarr",
          sonarrApiKey: "key",
        },
        jellyfin: fakeJf.jellyfin as never,
      });

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.getById(1);
        // Final state after the import->indexed transition runs in the same tick.
        expect(row?.acquisitionStatus).toBe("indexed");
        const meta = JSON.parse(row?.acquisitionMetadata ?? "{}");
        expect(meta.sonarrEpisodeFileId).toBe(1234);
      } finally {
        verify.close();
      }

      expect(fakeJf.calls.triggerLibraryRefresh).toBe(1);
    } finally {
      restore();
    }
  });

  test("404 on Sonarr episode marks the request failed", async () => {
    const restore = patchFetch(() => new Response("not found", { status: 404 }));

    try {
      const botStateDbPath = tmpPath("qr-tv-state");
      const subtitleDbPath = tmpPath("qr-tv-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Some Show",
        quoteText: "y",
        acquisitionKind: "sonarr",
        acquisitionExternalId: 999,
        acquisitionStatus: "searching",
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin();

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          sonarrUrl: "http://sonarr/sonarr",
          sonarrApiKey: "key",
        },
        jellyfin: fakeJf.jellyfin as never,
      });

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.getById(1);
        expect(row?.acquisitionStatus).toBe("failed");
      } finally {
        verify.close();
      }
    } finally {
      restore();
    }
  });

  test("does not call Sonarr when SONARR_URL is unset", async () => {
    let called = false;
    const restore = patchFetch(() => {
      called = true;
      return jsonResponse({});
    });

    try {
      const botStateDbPath = tmpPath("qr-tv-state");
      const subtitleDbPath = tmpPath("qr-tv-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Some Show",
        quoteText: "y",
        acquisitionKind: "sonarr",
        acquisitionExternalId: 22,
        acquisitionStatus: "searching",
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin();

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          sonarrUrl: undefined,
          sonarrApiKey: undefined,
        },
        jellyfin: fakeJf.jellyfin as never,
      });

      expect(called).toBe(false);
    } finally {
      restore();
    }
  });

  test("replays deferred sonarr request when integration becomes available (#129)", async () => {
    let lookupCalls = 0;
    let addSeriesCalls = 0;
    let monitorCalls = 0;
    let searchCalls = 0;

    const restore = patchFetch((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 4, name: "HD-1080p" }]);
      }
      if (url.endsWith("/api/v3/languageprofile")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([
          { id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3, accessible: true },
        ]);
      }
      if (url.includes("/api/v3/series/lookup")) {
        lookupCalls += 1;
        return jsonResponse([
          {
            tvdbId: 70327,
            title: "Buffy the Vampire Slayer",
            year: 1997,
            seasons: [{ seasonNumber: 2, monitored: false }],
          },
        ]);
      }
      if (method === "GET" && url.endsWith("/api/v3/series")) {
        return jsonResponse([]);
      }
      if (method === "POST" && url.endsWith("/api/v3/series")) {
        addSeriesCalls += 1;
        return jsonResponse({ id: 99, tvdbId: 70327, title: "Buffy" }, 201);
      }
      if (url.match(/\/api\/v3\/episode\?seriesId=99$/)) {
        return jsonResponse([
          {
            id: 555,
            seriesId: 99,
            seasonNumber: 2,
            episodeNumber: 5,
            monitored: false,
            hasFile: false,
          },
        ]);
      }
      if (url.endsWith("/api/v3/episode/555") && method === "GET") {
        return jsonResponse({
          id: 555,
          seriesId: 99,
          seasonNumber: 2,
          episodeNumber: 5,
          monitored: false,
          hasFile: false,
        });
      }
      if (url.endsWith("/api/v3/episode/555") && method === "PUT") {
        monitorCalls += 1;
        return jsonResponse({
          id: 555,
          seriesId: 99,
          seasonNumber: 2,
          episodeNumber: 5,
          monitored: true,
          hasFile: false,
        });
      }
      if (url.endsWith("/api/v3/command")) {
        searchCalls += 1;
        return jsonResponse({ id: 1, name: "EpisodeSearch", status: "queued" });
      }
      throw new Error("unexpected url " + url + " method=" + method);
    });

    try {
      const botStateDbPath = tmpPath("qr-tv-deferred");
      const subtitleDbPath = tmpPath("qr-tv-deferred-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Buffy",
        quoteText: "fictional quote",
        acquisitionKind: "sonarr",
        acquisitionStatus: "not_requested",
        acquisitionMetadata: JSON.stringify({
          season: 2,
          episode: 5,
          deferredReason: "sonarr_not_configured",
        }),
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin();

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          sonarrUrl: "http://sonarr/sonarr",
          sonarrApiKey: "key",
          sonarrMinFreeGb: 3,
          sonarrExcludedRootKeywords: [],
        },
        jellyfin: fakeJf.jellyfin as never,
      });

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.getById(1);
        expect(row?.acquisitionExternalId).toBe(555);
        expect(row?.acquisitionStatus).toBe("searching");
        const meta = JSON.parse(row?.acquisitionMetadata ?? "{}");
        expect(meta.tvdbId).toBe(70327);
        expect(meta.seriesId).toBe(99);
        expect(typeof meta.replayedAt).toBe("string");
        expect(meta.season).toBe(2);
        expect(meta.episode).toBe(5);
      } finally {
        verify.close();
      }

      expect(lookupCalls).toBeGreaterThanOrEqual(1);
      expect(addSeriesCalls).toBe(1);
      expect(monitorCalls).toBe(1);
      expect(searchCalls).toBe(1);
    } finally {
      restore();
    }
  });
});
