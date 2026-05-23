import { describe, expect, test } from "bun:test";
import { planClipRequest } from "../src/services/clip-request.ts";

describe("planClipRequest", () => {
  test("requires start", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: "abc",
      durationRaw: "30",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("start");
  });

  test("rejects end and duration together", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: "abc",
      startRaw: "0",
      endRaw: "30",
      durationRaw: "30",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-increasing range", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: "abc",
      startRaw: "2:00",
      endRaw: "1:00",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects clips over max length", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: "abc",
      startRaw: "0",
      durationRaw: "999",
      maxClipSeconds: 120,
    });
    expect(result.ok).toBe(false);
  });

  test("plans a valid clip", () => {
    const result = planClipRequest({
      kind: "tv",
      itemId: "abc",
      startRaw: "1:00",
      durationRaw: "30",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.durationSeconds).toBe(30);
      expect(result.plan.endSeconds).toBe(90);
    }
  });
});
