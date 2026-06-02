import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleQuoteRequestModalSubmit } from "../src/quote-requests/handle-modal.ts";
import { QuoteRequestStore } from "../src/quote-requests/store.ts";
import {
  QUOTE_REQUEST_TV_FIELD_EPISODE,
  QUOTE_REQUEST_TV_FIELD_QUOTE,
  QUOTE_REQUEST_TV_FIELD_SEASON,
  QUOTE_REQUEST_TV_FIELD_SHOW,
  QUOTE_REQUEST_TV_MODAL_ID,
} from "../src/quote-requests/modal.ts";

type ModalLikeInteraction = {
  guildId: string | null;
  channelId: string | null;
  customId: string;
  user: { id: string; displayName?: string; username: string };
  fields: { getTextInputValue: (id: string) => string };
  deferReply: (opts?: unknown) => Promise<void>;
  reply: (payload: unknown) => Promise<void>;
  editReply: (payload: unknown) => Promise<void>;
  replied?: boolean;
  deferred?: boolean;
};

function makeTvInteraction(opts: {
  show: string;
  season: string;
  episode: string;
  quote: string;
  userId?: string;
}): {
  interaction: ModalLikeInteraction;
  replies: { reply: unknown[]; editReply: unknown[]; deferred: boolean };
} {
  const replies = { reply: [] as unknown[], editReply: [] as unknown[], deferred: false };
  const interaction: ModalLikeInteraction = {
    guildId: "guild-1",
    channelId: "chan-1",
    customId: QUOTE_REQUEST_TV_MODAL_ID,
    user: { id: opts.userId ?? "user-7", username: "Heavy", displayName: "Heavy" },
    fields: {
      getTextInputValue: (id: string) => {
        if (id === QUOTE_REQUEST_TV_FIELD_SHOW) return opts.show;
        if (id === QUOTE_REQUEST_TV_FIELD_SEASON) return opts.season;
        if (id === QUOTE_REQUEST_TV_FIELD_EPISODE) return opts.episode;
        if (id === QUOTE_REQUEST_TV_FIELD_QUOTE) return opts.quote;
        return "";
      },
    },
    deferReply: async () => {
      replies.deferred = true;
    },
    reply: async (payload) => {
      replies.reply.push(payload);
    },
    editReply: async (payload) => {
      replies.editReply.push(payload);
    },
  };
  return { interaction, replies };
}

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

const baseSonarrConfig = {
  radarrUrl: undefined,
  radarrApiKey: undefined,
  radarrQualityProfileId: undefined,
  radarrRootFolderPath: undefined,
  radarrMinFreeGb: 3,
  sonarrUrl: "http://sonarr/sonarr",
  sonarrApiKey: "key",
  sonarrQualityProfileId: undefined,
  sonarrLanguageProfileId: undefined,
  sonarrRootFolderPath: undefined,
  sonarrMinFreeGb: 3,
  sonarrExcludedRootKeywords: [] as string[],
};

describe("handleQuoteRequestModalSubmit (TV)", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      try {
        unlinkSync(p);
      } catch {
        // ignore
      }
    }
  });

  function tmpDb(): string {
    const path = join(tmpdir(), `qr-tv-modal-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(path);
    return path;
  }

  test("happy path: looks up Sonarr, adds series unmonitored, monitors+searches the episode, persists", async () => {
    let postedSeries = false;
    let postedSearch = false;
    let putEpisode = false;

    const restore = patchFetch((url, init) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 4, name: "HD-1080p" }]);
      }
      if (url.endsWith("/api/v3/languageprofile")) {
        return jsonResponse([{ id: 1, name: "English" }]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3, accessible: true }]);
      }
      if (url.endsWith("/api/v3/series") && (init.method ?? "GET") === "GET") {
        return jsonResponse([]);
      }
      if (url.includes("/series/lookup?term=Buffy")) {
        return jsonResponse([
          {
            tvdbId: 70327,
            title: "Buffy the Vampire Slayer",
            year: 1997,
            seasons: [
              { seasonNumber: 1, monitored: true },
              { seasonNumber: 2, monitored: true },
            ],
          },
        ]);
      }
      if (url.includes("/series/lookup?term=tvdb%3A70327")) {
        return jsonResponse([
          {
            tvdbId: 70327,
            title: "Buffy the Vampire Slayer",
            year: 1997,
            seasons: [
              { seasonNumber: 1, monitored: true },
              { seasonNumber: 2, monitored: true },
            ],
          },
        ]);
      }
      if (url.endsWith("/api/v3/series") && init.method === "POST") {
        postedSeries = true;
        return jsonResponse(
          { id: 99, tvdbId: 70327, title: "Buffy the Vampire Slayer", monitored: false },
          201,
        );
      }
      if (url.includes("/api/v3/episode?seriesId=99")) {
        return jsonResponse([
          {
            id: 22,
            seriesId: 99,
            seasonNumber: 2,
            episodeNumber: 5,
            monitored: false,
            hasFile: false,
          },
        ]);
      }
      if (url.endsWith("/api/v3/episode/22") && init.method === "GET") {
        return jsonResponse({
          id: 22,
          seriesId: 99,
          seasonNumber: 2,
          episodeNumber: 5,
          monitored: false,
          hasFile: false,
        });
      }
      if (url.endsWith("/api/v3/episode/22") && init.method === "PUT") {
        putEpisode = true;
        return jsonResponse({ ...JSON.parse(String(init.body)), monitored: true });
      }
      if (url.endsWith("/api/v3/command") && init.method === "POST") {
        postedSearch = true;
        return jsonResponse({ id: 7, status: "queued" }, 201);
      }
      throw new Error("unexpected url " + url + " (" + (init.method ?? "GET") + ")");
    });

    try {
      const dbPath = tmpDb();
      const { interaction, replies } = makeTvInteraction({
        show: "Buffy the Vampire Slayer",
        season: "2",
        episode: "5",
        quote: "what's so funny?",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseSonarrConfig,
      });

      expect(replies.deferred).toBe(true);
      expect(replies.editReply.length).toBe(1);
      const reply = String(replies.editReply[0]);
      expect(reply).toContain("Buffy");
      expect(reply).toContain("S02E05");
      expect(postedSeries).toBe(true);
      expect(putEpisode).toBe(true);
      expect(postedSearch).toBe(true);

      const store = new QuoteRequestStore(dbPath);
      try {
        const pending = store.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]?.acquisitionKind).toBe("sonarr");
        expect(pending[0]?.acquisitionExternalId).toBe(22);
        expect(pending[0]?.acquisitionStatus).toBe("searching");
        const meta = JSON.parse(pending[0]!.acquisitionMetadata ?? "{}");
        expect(meta.tvdbId).toBe(70327);
        expect(meta.seriesId).toBe(99);
        expect(meta.seasonNumber).toBe(2);
        expect(meta.episodeNumber).toBe(5);
        expect(meta.alreadyAdded).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      restore();
    }
  });

  test("series already in Sonarr: skips addSeries POST, monitors+searches episode, persists alreadyAdded=true", async () => {
    let postedSeries = false;

    const restore = patchFetch((url, init) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 4, name: "HD-1080p" }]);
      }
      if (url.endsWith("/api/v3/languageprofile")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3, accessible: true }]);
      }
      if (url.endsWith("/api/v3/series") && (init.method ?? "GET") === "GET") {
        return jsonResponse([
          { id: 99, tvdbId: 70327, title: "Buffy the Vampire Slayer", monitored: false },
        ]);
      }
      if (url.includes("/series/lookup?term=Buffy")) {
        return jsonResponse([
          { tvdbId: 70327, title: "Buffy the Vampire Slayer", year: 1997 },
        ]);
      }
      if (url.endsWith("/api/v3/series") && init.method === "POST") {
        postedSeries = true;
        return jsonResponse({}, 201);
      }
      if (url.includes("/api/v3/episode?seriesId=99")) {
        return jsonResponse([
          {
            id: 22,
            seriesId: 99,
            seasonNumber: 2,
            episodeNumber: 5,
            monitored: false,
            hasFile: false,
          },
        ]);
      }
      if (url.endsWith("/api/v3/episode/22") && init.method === "GET") {
        return jsonResponse({
          id: 22,
          seriesId: 99,
          seasonNumber: 2,
          episodeNumber: 5,
          monitored: false,
          hasFile: false,
        });
      }
      if (url.endsWith("/api/v3/episode/22") && init.method === "PUT") {
        return jsonResponse({ ...JSON.parse(String(init.body)), monitored: true });
      }
      if (url.endsWith("/api/v3/command") && init.method === "POST") {
        return jsonResponse({ id: 7, status: "queued" }, 201);
      }
      throw new Error("unexpected url " + url + " (" + (init.method ?? "GET") + ")");
    });

    try {
      const dbPath = tmpDb();
      const { interaction, replies } = makeTvInteraction({
        show: "Buffy",
        season: "2",
        episode: "5",
        quote: "anything",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseSonarrConfig,
      });

      expect(postedSeries).toBe(false);
      const reply = String(replies.editReply[0]);
      expect(reply).toContain("already in Sonarr");

      const store = new QuoteRequestStore(dbPath);
      try {
        const pending = store.listPending();
        const meta = JSON.parse(pending[0]!.acquisitionMetadata ?? "{}");
        expect(meta.alreadyAdded).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      restore();
    }
  });

  test("rejects non-numeric season/episode without calling Sonarr", async () => {
    let calledSonarr = false;
    const restore = patchFetch(() => {
      calledSonarr = true;
      return jsonResponse({});
    });

    try {
      const dbPath = tmpDb();
      const { interaction, replies } = makeTvInteraction({
        show: "Buffy",
        season: "two",
        episode: "five",
        quote: "anything",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseSonarrConfig,
      });

      expect(calledSonarr).toBe(false);
      expect(replies.reply).toHaveLength(1);
      const replyContent = (replies.reply[0] as { content?: string }).content ?? "";
      expect(replyContent).toMatch(/Season|Episode|numbers/);
      expect(replies.deferred).toBe(false);

      const store = new QuoteRequestStore(dbPath);
      try {
        expect(store.listPending()).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      restore();
    }
  });

  test("Sonarr not configured: persists S/E in metadata as deferred sonarr request (#129)", async () => {
    const dbPath = tmpDb();
    const { interaction, replies } = makeTvInteraction({
      show: "Buffy",
      season: "2",
      episode: "5",
      quote: "anything",
    });

    await handleQuoteRequestModalSubmit(interaction as never, {
      botStateDbPath: dbPath,
      ...baseSonarrConfig,
      sonarrUrl: undefined,
      sonarrApiKey: undefined,
    });

    const reply = String(replies.editReply[0]);
    expect(reply).toContain("Sonarr isn't configured");
    expect(reply).toContain("Buffy");
    expect(reply).toContain("S02E05");

    const store = new QuoteRequestStore(dbPath);
    try {
      const pending = store.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.acquisitionKind).toBe("sonarr");
      expect(pending[0]?.acquisitionExternalId).toBeNull();
      expect(pending[0]?.acquisitionStatus).toBe("not_requested");

      const meta = JSON.parse(pending[0]?.acquisitionMetadata ?? "{}");
      expect(meta.season).toBe(2);
      expect(meta.episode).toBe(5);
      expect(meta.deferredReason).toBe("sonarr_not_configured");
      expect(typeof meta.deferredAt).toBe("string");
    } finally {
      store.close();
    }
  });
});
