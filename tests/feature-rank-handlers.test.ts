import { describe, expect, test } from "bun:test";
import {
  parseRankSelectCustomId,
  rankIntroMessage,
  rankSelectCustomId,
  rankTargetCount,
  shouldFinalizeRank,
} from "../src/features/rank-handlers.ts";

describe("rankTargetCount", () => {
  test("caps at three picks", () => {
    expect(rankTargetCount(10)).toBe(3);
    expect(rankTargetCount(3)).toBe(3);
  });

  test("matches open count when fewer than three", () => {
    expect(rankTargetCount(2)).toBe(2);
    expect(rankTargetCount(1)).toBe(1);
    expect(rankTargetCount(0)).toBe(0);
  });
});

describe("shouldFinalizeRank", () => {
  test("finalizes when target picks reached", () => {
    expect(shouldFinalizeRank(1, 1, 5)).toBe(true);
    expect(shouldFinalizeRank(2, 2, 3)).toBe(true);
    expect(shouldFinalizeRank(3, 3, 0)).toBe(true);
  });

  test("finalizes when nothing left to pick", () => {
    expect(shouldFinalizeRank(1, 3, 0)).toBe(true);
  });

  test("continues when more picks and options remain", () => {
    expect(shouldFinalizeRank(1, 3, 2)).toBe(false);
    expect(shouldFinalizeRank(2, 3, 1)).toBe(false);
  });
});

describe("rankIntroMessage", () => {
  test("explains single-suggestion flow", () => {
    expect(rankIntroMessage(1)).toContain("Only one");
  });

  test("explains two-suggestion flow", () => {
    expect(rankIntroMessage(2)).toContain("#2");
  });
});

describe("feature rank select ids", () => {
  test("round trips custom ids", () => {
    const customId = rankSelectCustomId(2, "abc-123");
    expect(parseRankSelectCustomId(customId)).toEqual({ step: 2, sessionId: "abc-123" });
  });
});
