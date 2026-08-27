import { describe, expect, test } from "bun:test";
import { runDeferredSync } from "../src/autocomplete.ts";

describe("runDeferredSync (#189)", () => {
  test("runs work on a later event-loop turn", async () => {
    let ran = false;
    const promise = runDeferredSync(() => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(false);
    await expect(promise).resolves.toBe(42);
    expect(ran).toBe(true);
  });

  test("propagates synchronous errors", async () => {
    await expect(
      runDeferredSync(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
