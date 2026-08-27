import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createWebApiHandler } from "../src/api/router.ts";
import { FixedWindowRateLimiter } from "../src/api/rate-limit.ts";
import { openSubtitleIndex } from "../src/subtitles/index-db.ts";
import { resetSubtitleSearchIndexForTests } from "../src/subtitles/search-index.ts";
import type { JellyfinClient } from "../src/jellyfin.ts";

const dbPath = `/tmp/jellybot-api-test-${crypto.randomUUID()}.db`;

const baseConfig = {
  webApiEnabled: true,
  webApiCorsOrigins: ["https://jellybot.introvrtlounge.com"],
  webApiPreviewTtlMs: 60_000,
  webApiMaxPreviewMb: 50,
  webApiRateLimitSuggestPerMinute: 100,
  webApiRateLimitPreviewPerHour: 100,
  clipTempDir: "/tmp",
  maxClipSeconds: 180,
  maxClipMb: 9,
  audioLanguages: "eng,en",
  subtitleLanguages: "eng,en",
  subtitleDbPath: dbPath,
  subtitleDefaultClipSeconds: 15,
  subtitleQuotePaddingSeconds: 2,
  watermarkPath: undefined,
};

const jellyfinStub = {
  search: async () => [],
  formatItemLabel: () => "Label",
} as unknown as JellyfinClient;

afterEach(() => {
  resetSubtitleSearchIndexForTests();
  try {
    unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

function seedQuoteIndex() {
  const index = openSubtitleIndex(dbPath);
  try {
    index.replaceItem(
      {
        itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        itemType: "Movie",
        title: "Demo Movie",
        productionYear: 2020,
        mediaSourceId: "src",
        subtitleIndex: 0,
      },
      [{ startMs: 1000, endMs: 2000, text: "hello world from jellybot" }],
    );
  } finally {
    index.close();
  }
}

describe("web api router", () => {
  test("returns null when path is outside /api/v1", async () => {
    const handler = createWebApiHandler({ config: baseConfig, jellyfin: jellyfinStub });
    const response = await handler(new Request("http://x/healthz"));
    expect(response).toBeNull();
  });

  test("serves quote suggestions with CORS", async () => {
    seedQuoteIndex();
    const handler = createWebApiHandler({ config: baseConfig, jellyfin: jellyfinStub });
    const response = await handler(
      new Request("http://x/api/v1/quote/suggest?q=hello", {
        headers: { origin: "https://jellybot.introvrtlounge.com" },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe(
      "https://jellybot.introvrtlounge.com",
    );
    const body = await response!.json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]?.text).toContain("hello world");
  });

  test("enforces suggest rate limits", async () => {
    seedQuoteIndex();
    const handler = createWebApiHandler({
      config: { ...baseConfig, webApiRateLimitSuggestPerMinute: 1 },
      jellyfin: jellyfinStub,
      suggestLimiter: new FixedWindowRateLimiter(1, 60_000),
    });

    const first = await handler(new Request("http://x/api/v1/quote/suggest?q=hello"));
    const second = await handler(new Request("http://x/api/v1/quote/suggest?q=hello"));
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(429);
  });

  test("rejects short quote queries without a series filter", async () => {
    seedQuoteIndex();
    const handler = createWebApiHandler({ config: baseConfig, jellyfin: jellyfinStub });
    const response = await handler(new Request("http://x/api/v1/quote/suggest?q=he"));
    const body = await response!.json();
    expect(body.suggestions).toHaveLength(0);
    expect(body.minQueryLength).toBe(3);
  });
});
