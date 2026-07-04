import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQuoteRequestReconcile, MAX_POLL_FAILURES } from "../src/quote-requests/reconciler.ts";
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
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeFakeClient() {
  const sent: { channelId: string; content?: string }[] = [];
  return {
    sent,
    client: {
      channels: {
        async fetch(channelId: string) {
          return {
            isTextBased: () => true,
            isDMBased: () => false,
            async send(payload: { content: string }) {
              sent.push({ channelId, ...payload });
              return { id: `msg-${sent.length}` };
            },
          };
        },
      },
    } as unknown as { channels: { fetch(id: string): Promise<unknown> } },
  };
}

function makeFakeJellyfin(found: boolean) {
  const calls = { findItemByTmdbId: 0, triggerLibraryRefresh: 0 };
  return {
    calls,
    jellyfin: {
      findItemByTmdbId: async (tmdbId: number) => {
        calls.findItemByTmdbId += 1;
        return found
          ? { id: "jf-item-" + tmdbId, name: "Weird Science", type: "Movie" }
          : null;
      },
      triggerLibraryRefresh: async () => {
        calls.triggerLibraryRefresh += 1;
      },
    },
  };
}

describe("Radarr reconciler poll path", () => {
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

  test("when Radarr reports hasFile=true, marks imported and triggers Jellyfin refresh", async () => {
    const restore = patchFetch((url) => {
      if (url.includes("/api/v3/movie/42")) {
        return jsonResponse({
          id: 42,
          tmdbId: 11814,
          title: "Weird Science",
          year: 1985,
          hasFile: true,
          monitored: true,
          movieFile: { path: "/data/movies/Weird Science (1985)/file.mkv" },
        });
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const botStateDbPath = tmpPath("qr-state");
      const subtitleDbPath = tmpPath("qr-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Weird Science",
        quoteText: "fictional quote",
        acquisitionKind: "radarr",
        acquisitionExternalId: 42,
        acquisitionStatus: "searching",
        acquisitionMetadata: JSON.stringify({ tmdbId: 11814 }),
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin(false);

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          radarrUrl: "http://radarr/radarr",
          radarrApiKey: "key",
        },
        jellyfin: fakeJf.jellyfin,
      });

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.listPending()[0];
        expect(row?.acquisitionStatus).toBe("imported");
        const meta = JSON.parse(row?.acquisitionMetadata ?? "{}");
        expect(meta.radarrMovieFilePath).toBe("/data/movies/Weird Science (1985)/file.mkv");
      } finally {
        verify.close();
      }

      expect(fakeJf.calls.triggerLibraryRefresh).toBe(1);
      expect(fakeJf.calls.findItemByTmdbId).toBe(1);
    } finally {
      restore();
    }
  });

  test("when Jellyfin already has the item, advances status to indexed", async () => {
    const restore = patchFetch((url) => {
      if (url.includes("/api/v3/movie/42")) {
        return jsonResponse({
          id: 42,
          tmdbId: 11814,
          title: "Weird Science",
          year: 1985,
          hasFile: true,
          monitored: true,
        });
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const botStateDbPath = tmpPath("qr-state");
      const subtitleDbPath = tmpPath("qr-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Weird Science",
        quoteText: "anything",
        acquisitionKind: "radarr",
        acquisitionExternalId: 42,
        acquisitionStatus: "imported",
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin(true);

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          radarrUrl: "http://radarr/radarr",
          radarrApiKey: "key",
        },
        jellyfin: fakeJf.jellyfin,
      });

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.listPending()[0];
        expect(row?.acquisitionStatus).toBe("indexed");
      } finally {
        verify.close();
      }
    } finally {
      restore();
    }
  });

  test("404 on Radarr movie marks the request failed", async () => {
    const restore = patchFetch(() => new Response("not found", { status: 404 }));

    try {
      const botStateDbPath = tmpPath("qr-state");
      const subtitleDbPath = tmpPath("qr-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "X",
        quoteText: "y",
        acquisitionKind: "radarr",
        acquisitionExternalId: 99,
        acquisitionStatus: "searching",
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin(false);

      await runQuoteRequestReconcile({
        client: fake.client as never,
        config: {
          botStateDbPath,
          subtitleDbPath,
          radarrUrl: "http://radarr/radarr",
          radarrApiKey: "key",
        },
        jellyfin: fakeJf.jellyfin,
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

  test("marks acquisition failed after MAX_POLL_FAILURES consecutive connectivity errors", async () => {
    const restore = patchFetch(() => {
      throw new Error("Unable to connect. Is the computer able to access the url?");
    });

    try {
      const botStateDbPath = tmpPath("qr-state");
      const subtitleDbPath = tmpPath("qr-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Weird Science",
        quoteText: "fictional quote",
        acquisitionKind: "radarr",
        acquisitionExternalId: 42,
        acquisitionStatus: "searching",
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin(false);
      const pollFailureCounts = new Map<number, number>();

      for (let i = 0; i < MAX_POLL_FAILURES; i++) {
        await runQuoteRequestReconcile(
          {
            client: fake.client as never,
            config: {
              botStateDbPath,
              subtitleDbPath,
              radarrUrl: "http://radarr/radarr",
              radarrApiKey: "key",
            },
            jellyfin: fakeJf.jellyfin,
          },
          pollFailureCounts,
        );
      }

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.getById(1);
        expect(row?.acquisitionStatus).toBe("failed");
        const meta = JSON.parse(row?.acquisitionMetadata ?? "{}");
        expect(meta.failureReason).toBe("radarr_unreachable");
        expect(meta.consecutiveFailures).toBe(MAX_POLL_FAILURES);
      } finally {
        verify.close();
      }

      expect(pollFailureCounts.has(1)).toBe(false);
    } finally {
      restore();
    }
  });

  test("resets poll failure count on successful Radarr response", async () => {
    let shouldFail = true;
    const restore = patchFetch((url) => {
      if (url.includes("/api/v3/movie/42")) {
        if (shouldFail) throw new Error("connection refused");
        return jsonResponse({
          id: 42,
          tmdbId: 11814,
          title: "Weird Science",
          year: 1985,
          hasFile: false,
          monitored: true,
        });
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const botStateDbPath = tmpPath("qr-state");
      const subtitleDbPath = tmpPath("qr-subs");

      const store = new QuoteRequestStore(botStateDbPath);
      store.insert({
        requesterDiscordId: "u1",
        requesterName: "U1",
        guildId: "g",
        channelId: "c",
        movieText: "Weird Science",
        quoteText: "fictional quote",
        acquisitionKind: "radarr",
        acquisitionExternalId: 42,
        acquisitionStatus: "searching",
      });
      store.close();

      const fake = makeFakeClient();
      const fakeJf = makeFakeJellyfin(false);
      const pollFailureCounts = new Map<number, number>();

      // Fail 5 times
      for (let i = 0; i < 5; i++) {
        await runQuoteRequestReconcile(
          {
            client: fake.client as never,
            config: {
              botStateDbPath,
              subtitleDbPath,
              radarrUrl: "http://radarr/radarr",
              radarrApiKey: "key",
            },
            jellyfin: fakeJf.jellyfin,
          },
          pollFailureCounts,
        );
      }
      expect(pollFailureCounts.get(1)).toBe(5);

      // Now succeed
      shouldFail = false;
      await runQuoteRequestReconcile(
        {
          client: fake.client as never,
          config: {
            botStateDbPath,
            subtitleDbPath,
            radarrUrl: "http://radarr/radarr",
            radarrApiKey: "key",
          },
          jellyfin: fakeJf.jellyfin,
        },
        pollFailureCounts,
      );
      expect(pollFailureCounts.has(1)).toBe(false);

      const verify = new QuoteRequestStore(botStateDbPath);
      try {
        const row = verify.getById(1);
        expect(row?.acquisitionStatus).toBe("searching");
      } finally {
        verify.close();
      }
    } finally {
      restore();
    }
  });

  test("listAcquiring filters out failed and indexed rows", () => {
    const dbPath = tmpPath("qr-state");
    const store = new QuoteRequestStore(dbPath);
    try {
      store.insert({
        requesterDiscordId: "u",
        requesterName: "U",
        guildId: "g",
        channelId: "c",
        movieText: "A",
        quoteText: "qa",
        acquisitionKind: "radarr",
        acquisitionExternalId: 1,
        acquisitionStatus: "searching",
      });
      store.insert({
        requesterDiscordId: "u",
        requesterName: "U",
        guildId: "g",
        channelId: "c",
        movieText: "B",
        quoteText: "qb",
        acquisitionKind: "radarr",
        acquisitionExternalId: 2,
        acquisitionStatus: "indexed",
      });
      store.insert({
        requesterDiscordId: "u",
        requesterName: "U",
        guildId: "g",
        channelId: "c",
        movieText: "C",
        quoteText: "qc",
        acquisitionKind: "radarr",
        acquisitionExternalId: 3,
        acquisitionStatus: "failed",
      });
      store.insert({
        requesterDiscordId: "u",
        requesterName: "U",
        guildId: "g",
        channelId: "c",
        movieText: "D",
        quoteText: "qd",
        acquisitionKind: "none",
      });

      const acquiring = store.listAcquiring();
      expect(acquiring.map((r) => r.movieText).sort()).toEqual(["A"]);
    } finally {
      store.close();
    }
  });
});
