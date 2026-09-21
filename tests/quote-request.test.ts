import { describe, expect, test } from "bun:test";
import { planQuoteClip } from "../src/services/quote-request.ts";
import type { QuoteSearchResult } from "../src/subtitles/index-db.ts";

const baseMatch: QuoteSearchResult = {
  itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  itemType: "Movie",
  title: "Test Movie",
  startMs: 30000,
  endMs: 34576,
  text: "love finds its way toward us",
  rank: 0,
  runtimeTicks: 120 * 60 * 10_000_000,
};

describe("planQuoteClip", () => {
  test("starts before the cue using default padding", () => {
    const planned = planQuoteClip({
      match: baseMatch,
      maxClipSeconds: 180,
      defaultClipSeconds: 15,
      defaultPaddingSeconds: 2,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.startSeconds).toBe(28);
    expect(planned.plan.durationSeconds).toBe(15);
    expect(planned.plan.kind).toBe("movie");
  });

  test("negative padding starts later than the cue (lead-in pulled in)", () => {
    const planned = planQuoteClip({
      match: baseMatch,
      paddingRaw: "-2",
      maxClipSeconds: 180,
      defaultClipSeconds: 15,
      defaultPaddingSeconds: 2,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.startSeconds).toBe(32);
    expect(planned.plan.cueStartSeconds).toBe(30);
  });

  test("rejects a negative lead-in that skips past the quote", () => {
    const planned = planQuoteClip({
      match: baseMatch,
      paddingRaw: "-10",
      maxClipSeconds: 180,
      defaultClipSeconds: 15,
      defaultPaddingSeconds: 2,
    });

    expect(planned.ok).toBe(false);
  });

  test("rejects clips longer than max", () => {
    const planned = planQuoteClip({
      match: baseMatch,
      durationRaw: "300",
      maxClipSeconds: 180,
      defaultClipSeconds: 15,
      defaultPaddingSeconds: 2,
    });

    expect(planned.ok).toBe(false);
  });
});
