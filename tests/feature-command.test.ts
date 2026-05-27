import { describe, expect, test } from "bun:test";
import { featureCommand } from "../src/commands/feature.ts";

describe("feature command contract", () => {
  const json = featureCommand.toJSON();

  test("registers suggest, rank, and choose subcommands", () => {
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["suggest", "rank", "choose"]);
  });

  test("choose uses autocomplete on issue option", () => {
    const choose = json.options?.find((option) => option.name === "choose");
    const issue = choose?.options?.find((option) => option.name === "issue");
    expect(issue?.autocomplete).toBe(true);
    expect(issue?.required).toBe(true);
  });
});
