import { describe, expect, test } from "bun:test";
import { planClipRequest } from "../src/services/clip-request.ts";

const ITEM_ID = "7d9e1a459fbb14ffa2411f68329d16d3";

describe("planClipRequest", () => {
  test("rejects free-typed media text", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: "The Matrix",
      startRaw: "0",
      durationRaw: "30",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("autocomplete");
  });

  test("requires start", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: ITEM_ID,
      durationRaw: "30",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("start");
  });

  test("requires media", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: "",
      startRaw: "0",
      durationRaw: "30",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("media");
  });

  test("rejects end and duration together", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: ITEM_ID,
      startRaw: "0",
      endRaw: "30",
      durationRaw: "30",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-increasing range", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: ITEM_ID,
      startRaw: "2:00",
      endRaw: "1:00",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects clips over max length", () => {
    const result = planClipRequest({
      kind: "movie",
      itemId: ITEM_ID,
      startRaw: "0",
      durationRaw: "999",
      maxClipSeconds: 180,
    });
    expect(result.ok).toBe(false);
  });

  test("plans a valid clip", () => {
    const result = planClipRequest({
      kind: "tv",
      itemId: ITEM_ID,
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
