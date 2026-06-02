import { describe, expect, test } from "bun:test";
import { tryHandleWebhook } from "../src/webhooks/router.ts";
import { WebhookDispatcher } from "../src/webhooks/dispatch.ts";
import type { JellyfinClient } from "../src/jellyfin.ts";

function silentDispatcher() {
  const enqueued: unknown[] = [];
  // Inject a setTimeout that never actually schedules anything. The
  // dispatcher returns a fake handle which our matching clearTimeout
  // accepts without doing anything. This keeps router tests fast and
  // never lets the indexer mock fire (router tests focus on auth + parse).
  const dispatcher = new WebhookDispatcher({
    jellyfin: {} as JellyfinClient,
    config: {
      subtitleDbPath: ":memory:",
      preferredLanguages: ["eng", "en"],
      debounceMs: 1,
      pollMaxAttempts: 1,
      pollIntervalMs: 1,
      postRefreshSettleMs: 0,
    },
    indexer: async () => ({ ok: true, itemId: "x", cueCount: 0 }),
    sleep: async () => undefined,
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
  });
  // monkey-patch enqueue to record kicks before the (no-op) timer call.
  const original = dispatcher.enqueue.bind(dispatcher);
  dispatcher.enqueue = (kick) => {
    enqueued.push(kick);
    return original(kick);
  };
  return { dispatcher, enqueued };
}

const SECRET = "s3cret-token";
const config = { sharedSecret: SECRET };

describe("tryHandleWebhook", () => {
  test("passes non-webhook paths back to the caller (returns null)", async () => {
    const { dispatcher } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/healthz", { method: "GET" }),
      config,
      dispatcher,
    );
    expect(result).toBeNull();
  });

  test("rejects unauthenticated POSTs with 401", async () => {
    const { dispatcher, enqueued } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/radarr", {
        method: "POST",
        body: JSON.stringify({ eventType: "Download", movie: { tmdbId: 1 } }),
        headers: { "content-type": "application/json" },
      }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  test("accepts a valid POST with X-Webhook-Token and enqueues the kick", async () => {
    const { dispatcher, enqueued } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/radarr", {
        method: "POST",
        body: JSON.stringify({
          eventType: "Download",
          movie: { tmdbId: 583, title: "Life of Brian" },
        }),
        headers: {
          "content-type": "application/json",
          "x-webhook-token": SECRET,
        },
      }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(200);
    expect(enqueued).toHaveLength(1);
  });

  test("accepts a valid POST with ?token= query string", async () => {
    const { dispatcher, enqueued } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request(`http://x/hooks/radarr?token=${SECRET}`, {
        method: "POST",
        body: JSON.stringify({
          eventType: "Download",
          movie: { tmdbId: 583, title: "Life of Brian" },
        }),
        headers: { "content-type": "application/json" },
      }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(200);
    expect(enqueued).toHaveLength(1);
  });

  test("returns 200 status:ignored when the parser produces null (e.g. Test event)", async () => {
    const { dispatcher, enqueued } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/radarr", {
        method: "POST",
        body: JSON.stringify({ eventType: "Test", movie: { tmdbId: 1 } }),
        headers: {
          "content-type": "application/json",
          "x-webhook-token": SECRET,
        },
      }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(200);
    const body = (await result!.json()) as { status: string };
    expect(body.status).toBe("ignored");
    expect(enqueued).toHaveLength(0);
  });

  test("rejects malformed JSON with 400", async () => {
    const { dispatcher, enqueued } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/radarr", {
        method: "POST",
        body: "{not json",
        headers: {
          "content-type": "application/json",
          "x-webhook-token": SECRET,
        },
      }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test("rejects unknown source paths with 404", async () => {
    const { dispatcher } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/jellyseerr", {
        method: "POST",
        body: "{}",
        headers: { "x-webhook-token": SECRET, "content-type": "application/json" },
      }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(404);
  });

  test("returns 404 when webhooks are disabled (empty secret)", async () => {
    const { dispatcher } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/radarr", { method: "POST", body: "{}" }),
      { sharedSecret: "" },
      dispatcher,
    );
    expect(result?.status).toBe(404);
  });

  test("GET on a hook path with valid token returns a small ready body", async () => {
    const { dispatcher } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request(`http://x/hooks/sonarr?token=${SECRET}`, { method: "GET" }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(200);
    const body = (await result!.json()) as { status: string; source: string };
    expect(body).toEqual({ status: "ready", source: "sonarr" });
  });

  test("GET without auth still returns 401 (don't leak presence to anonymous probes)", async () => {
    const { dispatcher } = silentDispatcher();
    const result = await tryHandleWebhook(
      new Request("http://x/hooks/sonarr", { method: "GET" }),
      config,
      dispatcher,
    );
    expect(result?.status).toBe(401);
  });
});
