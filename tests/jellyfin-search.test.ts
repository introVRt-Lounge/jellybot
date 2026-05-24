import { describe, expect, test } from "bun:test";
import { resolveTvSearchResults, type JellyfinItem } from "../src/jellyfin.ts";

const episode = (id: string, name: string, seriesName?: string): JellyfinItem => ({
  id,
  name,
  type: "Episode",
  seriesName,
});

const series = (id: string, name: string): JellyfinItem => ({
  id,
  name,
  type: "Series",
});

describe("resolveTvSearchResults", () => {
  test("returns direct episode matches when present", async () => {
    const results = await resolveTvSearchResults(
      [episode("ep1", "Pilot", "Breaking Bad")],
      [series("show1", "Spitting Image")],
      "pilot",
      async () => [episode("ep2", "Episode 1", "Spitting Image")],
      { maxSeriesToExpand: 3, episodesPerSeries: 25, totalLimit: 25 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("ep1");
  });

  test("expands series into episodes when episode search is empty", async () => {
    const results = await resolveTvSearchResults(
      [],
      [series("show1", "Spitting Image")],
      "spitt",
      async (_seriesId, options) => {
        expect(options.query).toBe("spitt");
        return [
          episode(`${_seriesId}-1`, "Episode 1", "Spitting Image"),
          episode(`${_seriesId}-2`, "Episode 2", "Spitting Image"),
        ];
      },
      { maxSeriesToExpand: 3, episodesPerSeries: 25, totalLimit: 25 },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.seriesName).toBe("Spitting Image");
  });
});
