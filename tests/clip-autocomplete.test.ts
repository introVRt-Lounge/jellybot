import { describe, expect, test } from "bun:test";
import {
  CLIP_AUTOCOMPLETE_BUSY_CHOICE,
  CLIP_AUTOCOMPLETE_BUSY_VALUE,
  getCachedClipMediaChoices,
  resetClipAutocompleteState,
  searchClipMediaAutocompleteChoices,
  setCachedClipMediaChoices,
} from "../src/clip-autocomplete.ts";
import type { JellyfinClient } from "../src/jellyfin.ts";

function mockJellyfin(results: Array<{ id: string; name: string; type: string }> = []): JellyfinClient {
  return {
    async search() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return results;
    },
    formatItemLabel(item) {
      return item.name;
    },
  } as JellyfinClient;
}

describe("searchClipMediaAutocompleteChoices", () => {
  test("returns a busy hint choice when the global limit is reached", async () => {
    resetClipAutocompleteState(1);
    const jellyfin = mockJellyfin([{ id: "a".repeat(32), name: "Slow", type: "Movie" }]);

    const first = searchClipMediaAutocompleteChoices(jellyfin, "slow", "movie");
    const second = await searchClipMediaAutocompleteChoices(jellyfin, "other", "movie");

    expect(second).toEqual([CLIP_AUTOCOMPLETE_BUSY_CHOICE]);
    await first;
  });

  test("serves cached results without occupying a search slot", async () => {
    resetClipAutocompleteState(1);
    const jellyfin = mockJellyfin([{ id: "b".repeat(32), name: "Cached", type: "Movie" }]);

    setCachedClipMediaChoices("movie", "cache", [{ name: "Cached hit", value: "c".repeat(32) }]);

    const first = searchClipMediaAutocompleteChoices(jellyfin, "slow", "movie");
    const cached = await searchClipMediaAutocompleteChoices(jellyfin, "cache", "movie");

    expect(cached).toEqual([{ name: "Cached hit", value: "c".repeat(32) }]);
    expect(getCachedClipMediaChoices("movie", "cache")).toEqual(cached);
    await first;
  });
});

describe("busy sentinel", () => {
  test("uses a non-item-id autocomplete value", () => {
    expect(CLIP_AUTOCOMPLETE_BUSY_VALUE).not.toMatch(/^[a-f0-9]{32}$/i);
  });
});
