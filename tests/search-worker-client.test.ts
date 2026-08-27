import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSubtitleIndex } from "../src/subtitles/index-db.ts";
import {
  searchQuotesOffThread,
  shutdownSubtitleSearchWorkerForTests,
} from "../src/subtitles/search-worker-client.ts";

describe.serial("searchQuotesOffThread (#192)", () => {
  const paths: string[] = [];
  let previousWorkerEnv: string | undefined;

  afterEach(() => {
    shutdownSubtitleSearchWorkerForTests();
    if (previousWorkerEnv === undefined) {
      delete process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER;
    } else {
      process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER = previousWorkerEnv;
    }
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
    paths.length = 0;
  });

  function tempDb(): string {
    const path = join(tmpdir(), `search-worker-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    return path;
  }

  test("returns FTS matches via worker", async () => {
    previousWorkerEnv = process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER;
    delete process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER;

    const dbPath = tempDb();
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Movie",
          title: "Evolution",
          productionYear: 2001,
          mediaSourceId: "src",
          subtitleIndex: 0,
        },
        [{ startMs: 0, endMs: 1000, text: "ca-caw tookie-tookie don't work", kind: "single" }],
      );
    } finally {
      index.close();
    }

    const results = await searchQuotesOffThread(dbPath, "ca-caw", 5, undefined, 5_000);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain("ca-caw");
  });

  test("interactive mode returns empty when worker disabled", async () => {
    previousWorkerEnv = process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER;
    process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER = "0";

    const dbPath = tempDb();
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "cccccccccccccccccccccccccccccccc",
          itemType: "Movie",
          title: "Test",
          productionYear: 2000,
          mediaSourceId: "src",
          subtitleIndex: 0,
        },
        [{ startMs: 0, endMs: 500, text: "hello world", kind: "single" }],
      );
    } finally {
      index.close();
    }

    const results = await searchQuotesOffThread(dbPath, "hello", 5, undefined, 5_000, {
      interactive: true,
    });
    expect(results).toEqual([]);
  });

  test("sync fallback when worker disabled and not interactive", async () => {
    previousWorkerEnv = process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER;
    process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER = "0";

    const dbPath = tempDb();
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          itemType: "Movie",
          title: "Test",
          productionYear: 2000,
          mediaSourceId: "src",
          subtitleIndex: 0,
        },
        [{ startMs: 0, endMs: 500, text: "hello world", kind: "single" }],
      );
    } finally {
      index.close();
    }

    const results = await searchQuotesOffThread(dbPath, "hello", 5, undefined, 5_000);
    expect(results).toHaveLength(1);
  });
});
