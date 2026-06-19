import { describe, expect, test } from "bun:test";
import { runDeferredSyncWithTimeout, yieldToEventLoop } from "../src/autocomplete.ts";

describe("yieldToEventLoop", () => {
  test("defers work to a later turn", async () => {
    let deferred = false;
    const pending = yieldToEventLoop().then(() => {
      deferred = true;
    });
    expect(deferred).toBe(false);
    await pending;
    expect(deferred).toBe(true);
  });
});

describe("runDeferredSyncWithTimeout", () => {
  test("does not run sync work before the defer turn", async () => {
    let ran = false;
    const pending = runDeferredSyncWithTimeout(
      () => {
        ran = true;
        return 42;
      },
      2500,
    );
    expect(ran).toBe(false);
    await expect(pending).resolves.toBe(42);
    expect(ran).toBe(true);
  });

  test("aborts before sync work when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    let ran = false;
    await expect(
      runDeferredSyncWithTimeout(
        () => {
          ran = true;
          return 1;
        },
        2500,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false);
  });

  test("returns sync result on the deferred turn", async () => {
    let turn = 0;
    await yieldToEventLoop();
    turn += 1;

    const value = await runDeferredSyncWithTimeout(() => {
      turn += 1;
      return "ok";
    }, 2500);

    expect(value).toBe("ok");
    expect(turn).toBe(2);
  });
});
