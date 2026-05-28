import { describe, expect, test } from "bun:test";
import { subcoverageCommand } from "../src/commands/subcoverage.ts";

describe("subcoverage command contract", () => {
  const json = subcoverageCommand.toJSON();

  test("uses expected command name", () => {
    expect(json.name).toBe("subcoverage");
  });

  test("declares kind and media options", () => {
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["kind", "media"]);
  });

  test("kind uses static choices for library, movie, and series", () => {
    const kind = json.options?.find((option) => option.name === "kind");
    expect(kind?.choices?.map((choice) => choice.value)).toEqual(["library", "movie", "series"]);
  });

  test("enables autocomplete on media only", () => {
    const media = json.options?.find((option) => option.name === "media");
    expect(media?.autocomplete).toBe(true);
  });
});
