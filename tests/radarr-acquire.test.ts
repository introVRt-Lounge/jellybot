import { describe, expect, test } from "bun:test";
import {
  checkDiskSpace,
  pickBestCandidate,
  resolveAcquisitionDefaults,
} from "../src/radarr/acquire.ts";
import type { RadarrLookupResult } from "../src/radarr/client.ts";

const weirdScience1985: RadarrLookupResult = { tmdbId: 11814, title: "Weird Science", year: 1985 };
const weirdScience2002: RadarrLookupResult = { tmdbId: 816839, title: "Weird Science", year: 2002 };
const weirdScience2: RadarrLookupResult = { tmdbId: 689385, title: "Weird Science 2: Strange Chemistry", year: 2013 };

describe("pickBestCandidate", () => {
  test("returns no_candidates for empty results", () => {
    const pick = pickBestCandidate([], { movieText: "anything" });
    expect("kind" in pick && pick.kind === "no_candidates").toBe(true);
  });

  test("prefers an exact title match over partial matches", () => {
    const pick = pickBestCandidate(
      [weirdScience2, weirdScience1985, weirdScience2002],
      { movieText: "weird science" },
    );
    if ("kind" in pick) throw new Error("expected a candidate");
    expect(pick.candidate.title).toBe("Weird Science");
  });

  test("year hint biases toward the matching release", () => {
    const pick = pickBestCandidate(
      [weirdScience2002, weirdScience1985],
      { movieText: "weird science", year: 1985 },
    );
    if ("kind" in pick) throw new Error("expected a candidate");
    expect(pick.candidate.year).toBe(1985);
  });

  test("returns alternatives in the result", () => {
    const pick = pickBestCandidate(
      [weirdScience1985, weirdScience2002, weirdScience2],
      { movieText: "weird science" },
    );
    if ("kind" in pick) throw new Error("expected a candidate");
    expect(pick.alternatives.length).toBeGreaterThan(0);
    expect(pick.alternatives.length).toBeLessThanOrEqual(4);
  });

  test("normalizes punctuation and articles when scoring", () => {
    const matrix: RadarrLookupResult = { tmdbId: 603, title: "The Matrix", year: 1999 };
    const pick = pickBestCandidate([matrix], { movieText: "matrix" });
    if ("kind" in pick) throw new Error("expected a candidate");
    expect(pick.candidate.tmdbId).toBe(603);
  });
});

describe("checkDiskSpace", () => {
  test("returns null when free space exceeds the minimum", () => {
    const refusal = checkDiskSpace(
      { qualityProfileId: 10, rootFolderPath: "/data/movies", rootFolderFreeBytes: 50 * 1024 ** 3 },
      3,
    );
    expect(refusal).toBeNull();
  });

  test("returns low_disk_space when below the minimum", () => {
    const refusal = checkDiskSpace(
      { qualityProfileId: 10, rootFolderPath: "/data/movies", rootFolderFreeBytes: 1 * 1024 ** 3 },
      3,
    );
    expect(refusal?.kind).toBe("low_disk_space");
    if (refusal?.kind !== "low_disk_space") throw new Error("expected refusal");
    expect(refusal.freeGb).toBe(1);
    expect(refusal.minGb).toBe(3);
  });
});

function fakeClient(input: {
  profiles: { id: number; name: string }[];
  roots: { id: number; path: string; freeSpace: number; accessible?: boolean }[];
}) {
  return {
    qualityProfiles: async () => input.profiles,
    rootFolders: async () => input.roots,
  } as unknown as Parameters<typeof resolveAcquisitionDefaults>[0];
}

describe("resolveAcquisitionDefaults", () => {
  test("auto-picks 'HD-1080p (no 4K)' when present", async () => {
    const result = await resolveAcquisitionDefaults(
      fakeClient({
        profiles: [
          { id: 4, name: "HD-1080p" },
          { id: 10, name: "HD-1080p (no 4K)" },
          { id: 5, name: "Ultra-HD" },
        ],
        roots: [{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3 }],
      }),
      {},
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.qualityProfileId).toBe(10);
    expect(result.rootFolderPath).toBe("/data/movies");
  });

  test("respects override quality profile id", async () => {
    const result = await resolveAcquisitionDefaults(
      fakeClient({
        profiles: [
          { id: 4, name: "HD-1080p" },
          { id: 10, name: "HD-1080p (no 4K)" },
        ],
        roots: [{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3 }],
      }),
      { qualityProfileId: 4 },
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.qualityProfileId).toBe(4);
  });

  test("refuses when no quality profile matches the override", async () => {
    const result = await resolveAcquisitionDefaults(
      fakeClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        roots: [{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3 }],
      }),
      { qualityProfileId: 99 },
    );
    expect("kind" in result && result.kind === "no_quality_profile").toBe(true);
  });

  test("refuses when override root folder doesn't exist", async () => {
    const result = await resolveAcquisitionDefaults(
      fakeClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        roots: [{ id: 1, path: "/data/movies", freeSpace: 50 * 1024 ** 3 }],
      }),
      { rootFolderPath: "/nope" },
    );
    expect("kind" in result && result.kind === "no_root_folder").toBe(true);
  });

  test("avoids erotic-named root folders by default", async () => {
    const result = await resolveAcquisitionDefaults(
      fakeClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        roots: [
          { id: 12, path: "/data/erotic", freeSpace: 1000 * 1024 ** 3 },
          { id: 10, path: "/data/movies", freeSpace: 5 * 1024 ** 3 },
        ],
      }),
      {},
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.rootFolderPath).toBe("/data/movies");
  });
});
