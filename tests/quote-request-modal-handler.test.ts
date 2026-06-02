import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleQuoteRequestModalSubmit } from "../src/quote-requests/handle-modal.ts";
import { QuoteRequestStore } from "../src/quote-requests/store.ts";
import {
  QUOTE_REQUEST_FIELD_MOVIE,
  QUOTE_REQUEST_FIELD_QUOTE,
  QUOTE_REQUEST_MODAL_ID,
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

function makeInteraction(opts: { movie: string; quote: string; userId?: string }): {
  interaction: ModalLikeInteraction;
  replies: { reply: unknown[]; editReply: unknown[]; deferred: boolean };
} {
  const replies = { reply: [] as unknown[], editReply: [] as unknown[], deferred: false };
  const interaction: ModalLikeInteraction = {
    guildId: "guild-1",
    channelId: "chan-1",
    customId: QUOTE_REQUEST_MODAL_ID,
    user: { id: opts.userId ?? "user-7", username: "Heavy", displayName: "Heavy" },
    fields: {
      getTextInputValue: (id: string) => {
        if (id === QUOTE_REQUEST_FIELD_MOVIE) return opts.movie;
        if (id === QUOTE_REQUEST_FIELD_QUOTE) return opts.quote;
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
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const baseRadarrConfig = {
  radarrUrl: "http://radarr/radarr",
  radarrApiKey: "key",
  radarrQualityProfileId: undefined,
  radarrRootFolderPath: undefined,
  radarrMinFreeGb: 3,
  sonarrUrl: undefined,
  sonarrApiKey: undefined,
  sonarrQualityProfileId: undefined,
  sonarrLanguageProfileId: undefined,
  sonarrRootFolderPath: undefined,
  sonarrMinFreeGb: 3,
  sonarrExcludedRootKeywords: [] as string[],
};

describe("handleQuoteRequestModalSubmit", () => {
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
    const path = join(tmpdir(), `qr-modal-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(path);
    return path;
  }

  test("happy path: looks up Radarr, picks best match, persists the row, replies with confirmation", async () => {
    const restore = patchFetch((url) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([
          { id: 4, name: "HD-1080p" },
          { id: 10, name: "HD-1080p (no 4K)" },
        ]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3, accessible: true }]);
      }
      if (url.includes("/movie/lookup?term=Weird%20Science")) {
        return jsonResponse([{ tmdbId: 11814, title: "Weird Science", year: 1985 }]);
      }
      if (url.includes("/movie/lookup?term=tmdb%3A11814")) {
        return jsonResponse([{ tmdbId: 11814, title: "Weird Science", year: 1985 }]);
      }
      if (url.endsWith("/api/v3/movie")) {
        return jsonResponse({ id: 42, tmdbId: 11814, title: "Weird Science", year: 1985, hasFile: false, monitored: true }, 201);
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const dbPath = tmpDb();
      const { interaction, replies } = makeInteraction({
        movie: "Weird Science",
        quote: "It's purely sexual",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseRadarrConfig,
      });

      expect(replies.deferred).toBe(true);
      expect(replies.editReply.length).toBe(1);
      const reply = String(replies.editReply[0]);
      expect(reply).toContain("Radarr");
      expect(reply).toContain("Weird Science");

      const store = new QuoteRequestStore(dbPath);
      try {
        const pending = store.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]?.acquisitionKind).toBe("radarr");
        expect(pending[0]?.acquisitionExternalId).toBe(42);
        expect(pending[0]?.acquisitionStatus).toBe("searching");
      } finally {
        store.close();
      }
    } finally {
      restore();
    }
  });

  test("low disk space refusal does not call Radarr addMovie and stores nothing", async () => {
    let postedMovie = false;
    const restore = patchFetch((url, init) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 10, name: "HD-1080p (no 4K)" }]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/movies", freeSpace: 1 * 1024 ** 3 }]);
      }
      if (init.method === "POST" && url.endsWith("/api/v3/movie")) {
        postedMovie = true;
      }
      return jsonResponse([]);
    });

    try {
      const dbPath = tmpDb();
      const { interaction, replies } = makeInteraction({
        movie: "Some Movie",
        quote: "some line",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseRadarrConfig,
      });

      const reply = String(replies.editReply[0]);
      expect(reply).toContain("only");
      expect(reply).toMatch(/GB free/);
      expect(postedMovie).toBe(false);

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

  test("falls back to State-B watch when Radarr is not configured", async () => {
    const dbPath = tmpDb();
    const { interaction, replies } = makeInteraction({
      movie: "Weird Science",
      quote: "I eat pieces of",
    });

    await handleQuoteRequestModalSubmit(interaction as never, {
      botStateDbPath: dbPath,
      radarrUrl: undefined,
      radarrApiKey: undefined,
      radarrQualityProfileId: undefined,
      radarrRootFolderPath: undefined,
      radarrMinFreeGb: 3,
      sonarrUrl: undefined,
      sonarrApiKey: undefined,
      sonarrQualityProfileId: undefined,
      sonarrLanguageProfileId: undefined,
      sonarrRootFolderPath: undefined,
      sonarrMinFreeGb: 3,
      sonarrExcludedRootKeywords: [],
    });

    const reply = String(replies.editReply[0]);
    expect(reply).toContain("Radarr isn't configured");

    const store = new QuoteRequestStore(dbPath);
    try {
      const pending = store.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.acquisitionKind).toBe("none");
    } finally {
      store.close();
    }
  });

  test("when movie is already in Radarr, captures the existing id and persists with the right status", async () => {
    const restore = patchFetch((url, init) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 10, name: "HD-1080p (no 4K)" }]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3 }]);
      }
      if (url.includes("/movie/lookup?term=Serenity")) {
        return jsonResponse([{ tmdbId: 16320, title: "Serenity", year: 2005 }]);
      }
      if (url.includes("/movie/lookup?term=tmdb%3A16320")) {
        return jsonResponse([{ tmdbId: 16320, title: "Serenity", year: 2005 }]);
      }
      if (init.method === "POST" && url.endsWith("/api/v3/movie")) {
        const body = JSON.stringify([
          {
            propertyName: "TmdbId",
            errorMessage: "This movie has already been added",
            attemptedValue: 16320,
            severity: "error",
            errorCode: "MovieExistsValidator",
          },
        ]);
        return new Response(body, { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/v3/movie?tmdbId=16320")) {
        return jsonResponse([
          { id: 555, tmdbId: 16320, title: "Serenity", year: 2005, hasFile: false, monitored: true },
        ]);
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const dbPath = tmpDb();
      const { interaction, replies } = makeInteraction({
        movie: "Serenity",
        quote: "I am a leaf on the wind",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseRadarrConfig,
      });

      const reply = String(replies.editReply[0]);
      expect(reply).toContain("already in Radarr");
      expect(reply).toContain("hunting for a release");

      const store = new QuoteRequestStore(dbPath);
      try {
        const pending = store.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]?.acquisitionKind).toBe("radarr");
        expect(pending[0]?.acquisitionExternalId).toBe(555);
        expect(pending[0]?.acquisitionStatus).toBe("searching");
      } finally {
        store.close();
      }
    } finally {
      restore();
    }
  });

  test("when already-in-Radarr movie has a file, status starts as imported", async () => {
    const restore = patchFetch((url, init) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 10, name: "HD-1080p (no 4K)" }]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3 }]);
      }
      if (url.includes("/movie/lookup?term=")) {
        return jsonResponse([{ tmdbId: 11814, title: "Weird Science", year: 1985 }]);
      }
      if (init.method === "POST" && url.endsWith("/api/v3/movie")) {
        return new Response(
          JSON.stringify([{ errorCode: "MovieExistsValidator", errorMessage: "already exists" }]),
          { status: 400 },
        );
      }
      if (url.includes("/api/v3/movie?tmdbId=11814")) {
        return jsonResponse([
          {
            id: 777,
            tmdbId: 11814,
            title: "Weird Science",
            year: 1985,
            hasFile: true,
            monitored: true,
          },
        ]);
      }
      throw new Error("unexpected url " + url);
    });

    try {
      const dbPath = tmpDb();
      const { interaction } = makeInteraction({
        movie: "Weird Science",
        quote: "fictional",
      });

      await handleQuoteRequestModalSubmit(interaction as never, {
        botStateDbPath: dbPath,
        ...baseRadarrConfig,
      });

      const store = new QuoteRequestStore(dbPath);
      try {
        const pending = store.listPending();
        expect(pending[0]?.acquisitionStatus).toBe("imported");
        expect(pending[0]?.acquisitionExternalId).toBe(777);
      } finally {
        store.close();
      }
    } finally {
      restore();
    }
  });

  test("rejects empty fields", async () => {
    const dbPath = tmpDb();
    const { interaction, replies } = makeInteraction({
      movie: "  ",
      quote: "something",
    });

    await handleQuoteRequestModalSubmit(interaction as never, {
      botStateDbPath: dbPath,
      ...baseRadarrConfig,
    });

    expect(replies.reply).toHaveLength(1);
    expect(replies.deferred).toBe(false);
  });
});
