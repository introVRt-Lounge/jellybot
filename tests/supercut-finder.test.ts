import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openSubtitleIndex, type IndexedCue, type IndexedMediaItem } from "../src/subtitles/index-db.ts";
import { coalesceCues, findSupercutCues, planSupercut, type SupercutCue } from "../src/supercut/finder.ts";

// Issue #140: supercut feature. Verifies that the FTS query path returns
// only `kind='single'` cues in chronological order, that coalesce + plan
// caps behave correctly, and that the series autocomplete query works.

function tempDbPath(): string {
  return `/tmp/jellybot-supercut-${crypto.randomUUID()}.db`;
}

const cleanup = (dbPath: string) => {
  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
};

const ARCHER_S2E7: IndexedMediaItem = {
  itemId: "ep-s2e7",
  itemType: "Episode",
  title: "Movie Star",
  seriesName: "Archer",
  seasonNumber: 2,
  episodeNumber: 7,
  mediaSourceId: "src",
  subtitleIndex: 0,
};

const ARCHER_S4E3: IndexedMediaItem = {
  itemId: "ep-s4e3",
  itemType: "Episode",
  title: "Legs",
  seriesName: "Archer",
  seasonNumber: 4,
  episodeNumber: 3,
  mediaSourceId: "src",
  subtitleIndex: 0,
};

const FUTURAMA_S1E1: IndexedMediaItem = {
  itemId: "ep-fut",
  itemType: "Episode",
  title: "Space Pilot",
  seriesName: "Futurama",
  seasonNumber: 1,
  episodeNumber: 1,
  mediaSourceId: "src",
  subtitleIndex: 0,
};

describe("supercut finder", () => {
  let dbPath: string;
  afterEach(() => {
    if (dbPath) cleanup(dbPath);
  });

  test("returns matching single cues in chronological order, filtered by series", () => {
    dbPath = tempDbPath();
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(ARCHER_S2E7, [
        { startMs: 1000, endMs: 2000, text: "mawp again", kind: "single" },
        { startMs: 5000, endMs: 6000, text: "mawp", kind: "single" },
        // merged window must NOT appear in results
        { startMs: 1000, endMs: 6000, text: "mawp again mawp", kind: "merged" },
      ] as IndexedCue[]);
      index.replaceItem(ARCHER_S4E3, [
        { startMs: 9000, endMs: 10000, text: "mawp", kind: "single" },
      ] as IndexedCue[]);
      // Same phrase in a different series - must be filtered out by seriesName
      index.replaceItem(FUTURAMA_S1E1, [
        { startMs: 0, endMs: 1000, text: "mawp", kind: "single" },
      ] as IndexedCue[]);

      const cues = findSupercutCues(index, {
        query: "mawp",
        seriesName: "Archer",
        searchLimit: 50,
      });

      // 3 hits across S2E7 (x2) and S4E3 (x1), ordered S2E7-startMs1000 -> S2E7-startMs5000 -> S4E3
      expect(cues.map((c) => c.startMs)).toEqual([1000, 5000, 9000]);
      expect(cues.every((c) => c.seriesName === "Archer")).toBe(true);
      // No merged-window rows leaked through
      expect(cues.find((c) => c.text.includes("again mawp"))).toBeUndefined();
    } finally {
      index.close();
    }
  });

  test("series filter is case insensitive", () => {
    dbPath = tempDbPath();
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(ARCHER_S2E7, [
        { startMs: 1000, endMs: 2000, text: "mawp", kind: "single" },
      ] as IndexedCue[]);

      const lower = findSupercutCues(index, {
        query: "mawp",
        seriesName: "archer",
        searchLimit: 10,
      });
      const exact = findSupercutCues(index, {
        query: "mawp",
        seriesName: "Archer",
        searchLimit: 10,
      });

      expect(lower.length).toBe(1);
      expect(exact.length).toBe(1);
    } finally {
      index.close();
    }
  });

  test("listSeriesNames returns distinct sorted names matching prefix", () => {
    dbPath = tempDbPath();
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(ARCHER_S2E7, [{ startMs: 0, endMs: 1, text: "x", kind: "single" } as IndexedCue]);
      index.replaceItem(ARCHER_S4E3, [{ startMs: 0, endMs: 1, text: "x", kind: "single" } as IndexedCue]);
      index.replaceItem(FUTURAMA_S1E1, [{ startMs: 0, endMs: 1, text: "x", kind: "single" } as IndexedCue]);

      const all = index.listSeriesNames("", 25);
      expect(all).toEqual(["Archer", "Futurama"]);

      const fuzzy = index.listSeriesNames("arch", 25);
      expect(fuzzy).toEqual(["Archer"]);

      const empty = index.listSeriesNames("nope", 25);
      expect(empty).toEqual([]);
    } finally {
      index.close();
    }
  });
});

function cue(startMs: number, endMs: number, text: string, itemId = "ep1"): SupercutCue {
  return {
    itemId,
    itemType: "Episode",
    title: "Movie Star",
    seriesName: "Archer",
    seasonNumber: 1,
    episodeNumber: 1,
    startMs,
    endMs,
    text,
  };
}

describe("coalesceCues", () => {
  test("merges adjacent cues from the same item within the gap window", () => {
    const merged = coalesceCues(
      [cue(1000, 1500, "a"), cue(1700, 2000, "b"), cue(5000, 5500, "c")],
      1000,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.startMs).toBe(1000);
    expect(merged[0]?.endMs).toBe(2000);
    expect(merged[0]?.text).toBe("a | b");
    expect(merged[1]?.startMs).toBe(5000);
  });

  test("does not merge across different items", () => {
    const merged = coalesceCues([cue(1000, 1500, "a", "x"), cue(1700, 2000, "b", "y")], 1000);
    expect(merged).toHaveLength(2);
  });

  test("respects the gap threshold", () => {
    const merged = coalesceCues([cue(1000, 1500, "a"), cue(3000, 3500, "b")], 1000);
    expect(merged).toHaveLength(2);
  });

  test("handles empty input", () => {
    expect(coalesceCues([], 1000)).toEqual([]);
  });
});

describe("planSupercut", () => {
  test("trims by max_clips first", () => {
    const cues = [cue(0, 1000, "a"), cue(2000, 3000, "b"), cue(4000, 5000, "c"), cue(6000, 7000, "d")];
    const plan = planSupercut({ cues, paddingMs: 0, maxClips: 2, maxDurationSeconds: 999 });
    expect(plan.cues).toHaveLength(2);
    expect(plan.trimmedForRuntime).toBe(2);
  });

  test("stops adding cues once duration cap would be exceeded", () => {
    const cues = [
      cue(0, 4000, "a"), // 4s
      cue(10000, 14000, "b"), // 4s
      cue(20000, 24000, "c"), // 4s
    ];
    const plan = planSupercut({ cues, paddingMs: 0, maxClips: 30, maxDurationSeconds: 6 });
    // First cue (4s) fits. Second (4s) would push to 8s > 6 cap, so stop.
    expect(plan.cues).toHaveLength(1);
    expect(plan.estimatedDurationSeconds).toBe(4);
    expect(plan.trimmedForRuntime).toBe(2);
  });

  test("padding is included in duration accounting", () => {
    // 1s cue + 0.4s padding each side = 1.8s
    const cues = [cue(0, 1000, "a"), cue(2000, 3000, "b")];
    const plan = planSupercut({ cues, paddingMs: 400, maxClips: 30, maxDurationSeconds: 999 });
    expect(plan.estimatedDurationSeconds).toBeCloseTo(3.6, 5);
  });

  test("always keeps at least one cue even if it exceeds the runtime cap", () => {
    const cues = [cue(0, 100000, "huge"), cue(120000, 121000, "small")];
    const plan = planSupercut({ cues, paddingMs: 0, maxClips: 30, maxDurationSeconds: 5 });
    expect(plan.cues).toHaveLength(1);
  });
});
