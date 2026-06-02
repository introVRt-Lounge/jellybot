import { describe, expect, test } from "bun:test";
import {
  acquireEpisode,
  checkSonarrDiskSpace,
  pickBestSeries,
  resolveSonarrDefaults,
} from "../src/sonarr/acquire.ts";
import type {
  SonarrClient,
  SonarrEpisode,
  SonarrLookupResult,
  SonarrSeries,
} from "../src/sonarr/client.ts";

const buffy: SonarrLookupResult = {
  tvdbId: 70327,
  title: "Buffy the Vampire Slayer",
  year: 1997,
};
const buffyAnimated: SonarrLookupResult = {
  tvdbId: 76690,
  title: "Buffy the Vampire Slayer: Animated",
  year: 2002,
};
const angel: SonarrLookupResult = { tvdbId: 73375, title: "Angel", year: 1999 };

describe("pickBestSeries", () => {
  test("returns no_candidates for empty results", () => {
    const pick = pickBestSeries([], { showText: "anything" });
    expect("kind" in pick && pick.kind === "no_candidates").toBe(true);
  });

  test("prefers an exact title match over partial matches", () => {
    const pick = pickBestSeries([buffyAnimated, buffy, angel], {
      showText: "buffy the vampire slayer",
    });
    if ("kind" in pick) throw new Error("expected a candidate");
    expect(pick.candidate.tvdbId).toBe(70327);
  });

  test("year hint biases toward the matching series", () => {
    const pick = pickBestSeries([buffyAnimated, buffy], {
      showText: "buffy",
      year: 1997,
    });
    if ("kind" in pick) throw new Error("expected a candidate");
    expect(pick.candidate.year).toBe(1997);
  });
});

describe("checkSonarrDiskSpace", () => {
  test("returns null when free space exceeds the minimum", () => {
    const refusal = checkSonarrDiskSpace(
      { qualityProfileId: 4, rootFolderPath: "/data/tv", rootFolderFreeBytes: 50 * 1024 ** 3 },
      3,
    );
    expect(refusal).toBeNull();
  });

  test("returns low_disk_space when below the minimum", () => {
    const refusal = checkSonarrDiskSpace(
      { qualityProfileId: 4, rootFolderPath: "/data/tv", rootFolderFreeBytes: 1 * 1024 ** 3 },
      3,
    );
    expect(refusal?.kind).toBe("low_disk_space");
  });
});

function fakeDefaultsClient(input: {
  profiles: { id: number; name: string }[];
  languages?: { id: number; name: string }[];
  roots: { id: number; path: string; freeSpace: number; accessible?: boolean }[];
}) {
  return {
    qualityProfiles: async () => input.profiles,
    languageProfiles: async () => input.languages ?? [],
    rootFolders: async () => input.roots,
  } as unknown as SonarrClient;
}

describe("resolveSonarrDefaults", () => {
  test("auto-picks 'HD-1080p (no 4K)' when present", async () => {
    const result = await resolveSonarrDefaults(
      fakeDefaultsClient({
        profiles: [
          { id: 4, name: "HD-1080p" },
          { id: 10, name: "HD-1080p (no 4K)" },
        ],
        roots: [{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3 }],
      }),
      {},
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.qualityProfileId).toBe(10);
    expect(result.rootFolderPath).toBe("/data/tv");
  });

  test("respects override quality profile id", async () => {
    const result = await resolveSonarrDefaults(
      fakeDefaultsClient({
        profiles: [
          { id: 4, name: "HD-1080p" },
          { id: 10, name: "HD-1080p (no 4K)" },
        ],
        roots: [{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3 }],
      }),
      { qualityProfileId: 4 },
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.qualityProfileId).toBe(4);
  });

  test("refuses when override root folder doesn't exist", async () => {
    const result = await resolveSonarrDefaults(
      fakeDefaultsClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        roots: [{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3 }],
      }),
      { rootFolderPath: "/nope" },
    );
    expect("kind" in result && result.kind === "no_root_folder").toBe(true);
  });

  test("excludedRootMatcher skips configured root folders", async () => {
    const result = await resolveSonarrDefaults(
      fakeDefaultsClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        roots: [
          { id: 12, path: "/data/special-collection", freeSpace: 1000 * 1024 ** 3 },
          { id: 10, path: "/data/tv", freeSpace: 5 * 1024 ** 3 },
        ],
      }),
      {},
      { excludedRootMatcher: (path) => path.toLowerCase().includes("special") },
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.rootFolderPath).toBe("/data/tv");
  });

  test("picks an English language profile when present", async () => {
    const result = await resolveSonarrDefaults(
      fakeDefaultsClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        languages: [
          { id: 7, name: "Spanish" },
          { id: 1, name: "English" },
        ],
        roots: [{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3 }],
      }),
      {},
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.languageProfileId).toBe(1);
  });

  test("languageProfileId is undefined when Sonarr has none", async () => {
    const result = await resolveSonarrDefaults(
      fakeDefaultsClient({
        profiles: [{ id: 4, name: "HD-1080p" }],
        roots: [{ id: 1, path: "/data/tv", freeSpace: 50 * 1024 ** 3 }],
      }),
      {},
    );
    if ("kind" in result) throw new Error("unexpected refusal");
    expect(result.languageProfileId).toBeUndefined();
  });
});

describe("acquireEpisode", () => {
  test("adds the series unmonitored when not present, then monitors and searches the episode", async () => {
    const calls: string[] = [];
    const series: SonarrSeries = {
      id: 99,
      tvdbId: 70327,
      title: "Buffy",
      monitored: false,
    };
    const episode: SonarrEpisode = {
      id: 22,
      seriesId: 99,
      seasonNumber: 2,
      episodeNumber: 5,
      monitored: false,
      hasFile: false,
    };
    const client: SonarrClient = {
      findSeriesByTvdbId: async () => {
        calls.push("findSeries");
        return null;
      },
      addSeriesUnmonitored: async () => {
        calls.push("addSeries");
        return series;
      },
      findEpisode: async () => {
        calls.push("findEpisode");
        return episode;
      },
      setEpisodeMonitored: async (id: number, monitored: boolean) => {
        calls.push(`setMonitored:${id}:${monitored}`);
        return { ...episode, monitored };
      },
      episodeSearch: async (ids: number[]) => {
        calls.push(`search:${ids.join(",")}`);
        return { id: 1, status: "queued" };
      },
    } as unknown as SonarrClient;

    const result = await acquireEpisode({
      client,
      candidate: { tvdbId: 70327, title: "Buffy", year: 1997 },
      defaults: { qualityProfileId: 4, rootFolderPath: "/data/tv", rootFolderFreeBytes: 1e12 },
      seasonNumber: 2,
      episodeNumber: 5,
    });

    expect(result.alreadyAdded).toBe(false);
    expect(calls).toEqual([
      "findSeries",
      "addSeries",
      "findEpisode",
      "setMonitored:22:true",
      "search:22",
    ]);
  });

  test("does not re-add when the series already exists; only monitors and searches the episode", async () => {
    const calls: string[] = [];
    const existing: SonarrSeries = {
      id: 99,
      tvdbId: 70327,
      title: "Buffy",
      monitored: false,
    };
    const episode: SonarrEpisode = {
      id: 22,
      seriesId: 99,
      seasonNumber: 2,
      episodeNumber: 5,
      monitored: false,
      hasFile: false,
    };
    const client: SonarrClient = {
      findSeriesByTvdbId: async () => {
        calls.push("findSeries");
        return existing;
      },
      addSeriesUnmonitored: async () => {
        calls.push("addSeries");
        throw new Error("must not be called");
      },
      findEpisode: async () => {
        calls.push("findEpisode");
        return episode;
      },
      setEpisodeMonitored: async (id: number, monitored: boolean) => {
        calls.push(`setMonitored:${id}:${monitored}`);
        return { ...episode, monitored };
      },
      episodeSearch: async (ids: number[]) => {
        calls.push(`search:${ids.join(",")}`);
        return { id: 1, status: "queued" };
      },
    } as unknown as SonarrClient;

    const result = await acquireEpisode({
      client,
      candidate: { tvdbId: 70327, title: "Buffy", year: 1997 },
      defaults: { qualityProfileId: 4, rootFolderPath: "/data/tv", rootFolderFreeBytes: 1e12 },
      seasonNumber: 2,
      episodeNumber: 5,
    });

    expect(result.alreadyAdded).toBe(true);
    expect(calls).toEqual([
      "findSeries",
      "findEpisode",
      "setMonitored:22:true",
      "search:22",
    ]);
  });

  test("skips episodeSearch when the episode already has a file on disk", async () => {
    const calls: string[] = [];
    const series: SonarrSeries = { id: 99, tvdbId: 70327, title: "Buffy", monitored: false };
    const episode: SonarrEpisode = {
      id: 22,
      seriesId: 99,
      seasonNumber: 2,
      episodeNumber: 5,
      monitored: false,
      hasFile: true,
    };
    const client: SonarrClient = {
      findSeriesByTvdbId: async () => series,
      addSeriesUnmonitored: async () => series,
      findEpisode: async () => episode,
      setEpisodeMonitored: async (id: number, monitored: boolean) => {
        calls.push(`setMonitored:${id}:${monitored}`);
        return { ...episode, monitored };
      },
      episodeSearch: async () => {
        calls.push("search");
        return { id: 1, status: "queued" };
      },
    } as unknown as SonarrClient;

    await acquireEpisode({
      client,
      candidate: { tvdbId: 70327, title: "Buffy" },
      defaults: { qualityProfileId: 4, rootFolderPath: "/data/tv", rootFolderFreeBytes: 1e12 },
      seasonNumber: 2,
      episodeNumber: 5,
    });

    expect(calls).toContain("setMonitored:22:true");
    expect(calls).not.toContain("search");
  });

  test("throws when Sonarr has the series but lacks the requested episode", async () => {
    const series: SonarrSeries = { id: 99, tvdbId: 70327, title: "Buffy", monitored: false };
    const client: SonarrClient = {
      findSeriesByTvdbId: async () => series,
      findEpisode: async () => null,
    } as unknown as SonarrClient;

    await expect(
      acquireEpisode({
        client,
        candidate: { tvdbId: 70327, title: "Buffy" },
        defaults: { qualityProfileId: 4, rootFolderPath: "/data/tv", rootFolderFreeBytes: 1e12 },
        seasonNumber: 9,
        episodeNumber: 9,
      }),
    ).rejects.toThrow(/no episode S9E9/);
  });
});
