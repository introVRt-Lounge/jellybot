import { afterEach, describe, expect, test } from "bun:test";
import {
  bumpInteractivePriority,
  isInteractivePriorityActive,
  resetInteractivePriorityForTests,
} from "../src/interactive-priority.ts";

describe("interactive priority (#192)", () => {
  afterEach(() => {
    resetInteractivePriorityForTests();
  });

  test("bump extends the interactive window", () => {
    expect(isInteractivePriorityActive()).toBe(false);
    bumpInteractivePriority(500);
    expect(isInteractivePriorityActive()).toBe(true);
  });

  test("later bumps extend but never shorten", () => {
    bumpInteractivePriority(100);
    const firstUntil = Date.now() + 100;
    bumpInteractivePriority(5_000);
    expect(isInteractivePriorityActive()).toBe(true);
    expect(firstUntil).toBeLessThan(Date.now() + 5_000);
  });
});
