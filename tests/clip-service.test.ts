import { describe, expect, test } from "bun:test";
import { validateClipItem } from "../src/services/clip-service.ts";

describe("validateClipItem", () => {
  test("rejects missing items", () => {
    const result = validateClipItem(null, {
      kind: "movie",
      itemId: "abc",
      startSeconds: 0,
      endSeconds: 30,
      durationSeconds: 30,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects wrong media kind", () => {
    const result = validateClipItem(
      { id: "abc", name: "Pilot", type: "Episode" },
      {
        kind: "movie",
        itemId: "abc",
        startSeconds: 0,
        endSeconds: 30,
        durationSeconds: 30,
      },
    );
    expect(result.ok).toBe(false);
  });

  test("rejects start beyond runtime", () => {
    const result = validateClipItem(
      {
        id: "abc",
        name: "Short",
        type: "Movie",
        runtimeTicks: 60 * 10_000_000,
      },
      {
        kind: "movie",
        itemId: "abc",
        startSeconds: 120,
        endSeconds: 150,
        durationSeconds: 30,
      },
    );
    expect(result.ok).toBe(false);
  });
});
