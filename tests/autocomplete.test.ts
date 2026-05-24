import { describe, expect, test } from "bun:test";
import { compactItemLabel, toAutocompleteChoices, uniqueChoiceName } from "../src/autocomplete.ts";
import type { JellyfinItem } from "../src/jellyfin.ts";

const formatter = (item: JellyfinItem) => item.name;

describe("compactItemLabel", () => {
  test("shortens long tv labels", () => {
    const label = compactItemLabel(
      {
        id: "1",
        name: "The Siege of Lothal (1) WEBRip extra long episode title here",
        type: "Episode",
        seriesName: "Star Wars Rebels with an extremely long show name for testing",
      },
      "tv",
    );

    expect(label.length).toBeLessThanOrEqual(100);
  });
});

describe("uniqueChoiceName", () => {
  test("adds suffixes for duplicate display names", () => {
    const seen = new Set<string>(["Maniac - S01E01 The Chosen One!"]);
    expect(uniqueChoiceName("Maniac - S01E01 The Chosen One!", seen)).toBe("Maniac - S01E01 The Chosen One! (2)");
  });
});

describe("toAutocompleteChoices", () => {
  test("dedupes ids and enforces discord limits", () => {
    const longName = "A".repeat(120);
    const choices = toAutocompleteChoices(
      [
        { id: "abc", name: longName, type: "Movie", productionYear: 1999 },
        { id: "abc", name: "duplicate", type: "Movie" },
        { id: "def", name: "Other", type: "Movie" },
      ],
      "movie",
      formatter,
    );

    expect(choices).toHaveLength(2);
    expect(choices[0]?.name.length).toBeLessThanOrEqual(100);
    expect(choices[0]?.value.length).toBeLessThanOrEqual(100);
    expect(choices.every((choice, index, all) => all.findIndex((c) => c.value === choice.value) === index)).toBe(true);
  });

  test("keeps choice names unique for discord autocomplete", () => {
    const shared = "Maniac - S01E01 The Chosen One!";
    const choices = toAutocompleteChoices(
      [
        { id: "1", name: shared, type: "Episode", seriesName: "Maniac" },
        { id: "2", name: shared, type: "Episode", seriesName: "Maniac" },
      ],
      "tv",
      formatter,
    );

    const names = choices.map((choice) => choice.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
