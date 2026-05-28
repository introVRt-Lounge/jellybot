import { describe, expect, test } from "bun:test";
import { evaluateSuggestionHeuristic, evaluateSuggestionScope } from "../src/features/scope-gate.ts";

describe("feature scope gate", () => {
  test("passes Jellyfin-aligned suggestions", () => {
    const result = evaluateSuggestionHeuristic("Clip Jellyfin movie moments with burned subtitles");
    expect(result.ok).toBe(true);
  });

  test("passes meta tooling and transparency requests without keyword hints", () => {
    const result = evaluateSuggestionHeuristic(
      "Show the guild a report of subtitle coverage across the library so we know what quote can find",
    );
    expect(result.ok).toBe(true);
  });

  test("passes ideas that are not direct clip features (consideration queue)", () => {
    const result = evaluateSuggestionHeuristic("Build a moderation ticketing bot for Discord");
    expect(result.ok).toBe(true);
  });

  test("rejects obvious spam patterns", () => {
    const result = evaluateSuggestionHeuristic("buy now crypto nft gambling click here free money");
    expect(result.ok).toBe(false);
  });

  test("rejects very short descriptions", () => {
    const result = evaluateSuggestionHeuristic("more clips");
    expect(result.ok).toBe(false);
  });

  test("openai path forwards even when model would reject (assume yes)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  pass: false,
                  reason: "Not directly about clipping",
                  summary: "Subtitle coverage dashboard",
                  userStory: "As a guild member I want coverage stats",
                  acceptance: ["Post stats in Discord"],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    try {
      const result = await evaluateSuggestionScope(
        "Report subtitle coverage across the library for the community",
        "test-key",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issueBody).toContain("Automated note for maintainer");
        expect(result.summary).toBe("Subtitle coverage dashboard");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
