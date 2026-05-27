import { describe, expect, test } from "bun:test";
import { evaluateSuggestionHeuristic } from "../src/features/scope-gate.ts";

describe("feature scope gate", () => {
  test("passes Jellyfin-aligned suggestions", () => {
    const result = evaluateSuggestionHeuristic("Clip Jellyfin movie moments with burned subtitles");
    expect(result.ok).toBe(true);
  });

  test("rejects unrelated utilities", () => {
    const result = evaluateSuggestionHeuristic("Build a moderation ticketing bot for Discord");
    expect(result.ok).toBe(false);
  });
});
