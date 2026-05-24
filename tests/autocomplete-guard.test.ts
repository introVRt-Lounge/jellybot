import { describe, expect, test } from "bun:test";
import { AutocompleteSessionGuard, isAbortError } from "../src/autocomplete-guard.ts";
import { resolveTvSearchResults } from "../src/jellyfin.ts";

describe("AutocompleteSessionGuard", () => {
  test("aborts the previous in-flight session when a new keystroke arrives", () => {
    const guard = new AutocompleteSessionGuard();
    const first = guard.beginCancellable("user:clip:media");
    const second = guard.beginCancellable("user:clip:media");

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });
});

describe("isAbortError", () => {
  test("detects abort errors", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  });
});

describe("resolveTvSearchResults abort", () => {
  test("stops expanding series when aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveTvSearchResults([], [{ id: "show1", name: "Show", type: "Series" }], "show", async () => {
        throw new Error("should not expand");
      }, {
        maxSeriesToExpand: 3,
        episodesPerSeries: 25,
        totalLimit: 25,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
