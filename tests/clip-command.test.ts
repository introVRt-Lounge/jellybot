import { describe, expect, test } from "bun:test";
import { clipCommand } from "../src/commands/clip.ts";

describe("clip command contract", () => {
  const json = clipCommand.toJSON();

  test("uses expected command name", () => {
    expect(json.name).toBe("clip");
  });

  test("declares kind, media, start, end, duration options", () => {
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["kind", "media", "start", "end", "duration"]);
  });

  test("keeps start optional for autocomplete compatibility", () => {
    const start = json.options?.find((option) => option.name === "start");
    expect(start?.required).toBe(false);
  });

  test("enables autocomplete only on media", () => {
    const media = json.options?.find((option) => option.name === "media");
    expect(media?.autocomplete).toBe(true);
  });
});
