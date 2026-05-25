import { describe, expect, test } from "bun:test";
import { clipCommand } from "../src/commands/clip.ts";

describe("clip command contract", () => {
  const json = clipCommand.toJSON();

  test("uses expected command name", () => {
    expect(json.name).toBe("clip");
  });

  test("declares kind, media, start, end, duration, subtitles options", () => {
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["kind", "media", "start", "end", "duration", "subtitles"]);
  });

  test("uses autocomplete instead of static choices for discord validation compatibility", () => {
    const kind = json.options?.find((option) => option.name === "kind");
    expect(kind?.autocomplete).toBe(true);
    expect(kind?.choices).toBeUndefined();
  });

  test("keeps start and media optional for autocomplete compatibility", () => {
    const start = json.options?.find((option) => option.name === "start");
    const media = json.options?.find((option) => option.name === "media");
    expect(start?.required).toBe(false);
    expect(media?.required).toBe(false);
  });

  test("enables autocomplete on kind and media", () => {
    const media = json.options?.find((option) => option.name === "media");
    const kind = json.options?.find((option) => option.name === "kind");
    expect(media?.autocomplete).toBe(true);
    expect(kind?.autocomplete).toBe(true);
  });
});
