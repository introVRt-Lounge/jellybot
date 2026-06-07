import { describe, expect, test } from "bun:test";
import { buildSupercutCommand } from "../src/commands/supercut.ts";

// Issue #140: command contract. Verifies the slash command shape is what
// register-commands publishes to Discord. Behavioural tests for the
// in-flight mutex and "too few hits" path live alongside the command code
// path's unit-level helpers.

describe("supercut command contract", () => {
  test("uses expected name and description", () => {
    const json = buildSupercutCommand(30).toJSON();
    expect(json.name).toBe("supercut");
    expect(json.description.toLowerCase()).toContain("supercut");
  });

  test("declares phrase + series + max_clips options in that order", () => {
    const json = buildSupercutCommand(30).toJSON();
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["phrase", "series", "max_clips"]);
  });

  test("phrase is required, series is required and autocompleted, max_clips is bounded", () => {
    const json = buildSupercutCommand(20).toJSON();
    const phrase = json.options?.find((o) => o.name === "phrase");
    const series = json.options?.find((o) => o.name === "series");
    const max = json.options?.find((o) => o.name === "max_clips") as
      | { required?: boolean; min_value?: number; max_value?: number }
      | undefined;

    expect(phrase?.required).toBe(true);
    expect(series?.required).toBe(true);
    expect((series as { autocomplete?: boolean })?.autocomplete).toBe(true);
    expect(max?.required).toBe(false);
    expect(max?.min_value).toBe(3);
    expect(max?.max_value).toBe(20);
  });

  test("max_clips ceiling tracks the configured limit", () => {
    expect(
      (buildSupercutCommand(15).toJSON().options?.find((o) => o.name === "max_clips") as { max_value?: number })
        ?.max_value,
    ).toBe(15);
    expect(
      (buildSupercutCommand(45).toJSON().options?.find((o) => o.name === "max_clips") as { max_value?: number })
        ?.max_value,
    ).toBe(45);
  });
});
