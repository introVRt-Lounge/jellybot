import { describe, expect, test } from "bun:test";
import {
  runDeferredSyncWithTimeout,
  waitDebounced,
  yieldToEventLoop,
  remainingAutocompleteBudgetMs,
  isAutocompleteInteractionExpired,
  autocompleteInteractionAgeMs,
  QUOTE_MATCH_AUTOCOMPLETE_DEBOUNCE_MS,
} from "../src/autocomplete.ts";
import { AutocompleteSessionGuard } from "../src/autocomplete-guard.ts";

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

describe("remainingAutocompleteBudgetMs", () => {
  test("subtracts elapsed interaction age from the max budget", () => {
    const interaction = { createdTimestamp: Date.now() - 700 };
    expect(remainingAutocompleteBudgetMs(interaction, 2500)).toBe(1800);
  });

  test("never returns less than the floor", () => {
    const interaction = { createdTimestamp: Date.now() - 3000 };
    expect(remainingAutocompleteBudgetMs(interaction, 2500)).toBe(50);
  });
});

describe("quote match autocomplete debounce (#173)", () => {
  test("stays at or under 100ms so gateway RTT still fits Discord's ~3s budget", () => {
    expect(QUOTE_MATCH_AUTOCOMPLETE_DEBOUNCE_MS).toBeLessThanOrEqual(100);
  });
});

describe("waitDebounced", () => {
  test("resolves after the debounce interval", async () => {
    const controller = new AbortController();
    const started = Date.now();
    await waitDebounced(50, controller.signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("rejects when aborted before the debounce interval elapses", async () => {
    const controller = new AbortController();
    const pending = waitDebounced(200, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("aborts debounce wait when AutocompleteSessionGuard supersedes a keystroke", async () => {
    const guard = new AutocompleteSessionGuard();
    const first = guard.beginCancellable("user:quote:match");
    const pending = waitDebounced(200, first.signal);
    guard.beginCancellable("user:quote:match");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("autocomplete soft expiry vs Discord hard limit (#173)", () => {
  test("soft 2500ms guard leaves headroom under Discord's ~3000ms hard limit", () => {
    const softMs = 2500;
    const interaction = { createdTimestamp: Date.now() - (softMs + 1) };
    expect(isAutocompleteInteractionExpired(interaction, softMs)).toBe(true);
    // Age just past soft guard should still be under a typical 3s client deadline.
    expect(autocompleteInteractionAgeMs(interaction)).toBeLessThan(3000);
  });
});
