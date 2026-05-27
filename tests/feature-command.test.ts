import { describe, expect, test } from "bun:test";
import { featureCommand } from "../src/commands/feature.ts";
import { parseRankSelectCustomId, rankSelectCustomId } from "../src/features/rank-handlers.ts";

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

describe("feature rank select ids", () => {
  test("round trips custom ids", () => {
    const customId = rankSelectCustomId(2, "abc-123");
    expect(parseRankSelectCustomId(customId)).toEqual({ step: 2, sessionId: "abc-123" });
  });
});
