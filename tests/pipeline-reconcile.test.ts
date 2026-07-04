import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reconcileBuildingSuggestions,
  MAX_RECONCILE_FAILURES,
} from "../src/features/pipeline-reconcile.ts";
import { FeatureStore } from "../src/features/feature-store.ts";

function tmpPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.db`);
}

function makeFakeClient() {
  return { channels: { fetch: async () => null } } as never;
}

function makeFakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    githubToken: "fake-token",
    releaseRepoOwner: "owner",
    releaseRepoName: "repo",
    discordBotspamChannelId: null,
    ...overrides,
  } as never;
}

function patchFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return handler(url);
  }) as unknown as typeof fetch;
  return () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
  };
}

describe("pipeline reconcile failure handling", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  });

  function createDb(): string {
    const path = tmpPath("pipe-reconcile");
    paths.push(path);
    return path;
  }

  test("marks suggestion rejected after MAX_RECONCILE_FAILURES consecutive API failures", async () => {
    const restore = patchFetch(() => new Response("", { status: 200 }));

    try {
      const dbPath = createDb();
      const store = new FeatureStore(dbPath);
      store.insertSuggestion({
        githubIssueNumber: 82,
        title: "Test feature",
        description: "desc",
        suggesterDiscordId: "u1",
        suggesterName: "Tester",
        guildId: "g1",
        scopeSummary: null,
      });
      store.setStatus(1, "building");

      const client = makeFakeClient();
      const config = makeFakeConfig();
      const failureCounts = new Map<number, number>();

      for (let i = 0; i < MAX_RECONCILE_FAILURES; i++) {
        await reconcileBuildingSuggestions(client, config, store, "g1", failureCounts);
      }

      const suggestion = store.getById(1);
      expect(suggestion?.status).toBe("rejected");

      const event = store.latestPipelineEvent(1);
      expect(event?.stage).toBe("failed");
      expect(event?.status).toBe("failed");
      expect(event?.detail).toContain("consecutive API failures");

      expect(failureCounts.has(1)).toBe(false);
    } finally {
      restore();
    }
  });

  test("resets failure count on successful inspection", async () => {
    let shouldFail = true;
    const restore = patchFetch((url) => {
      if (shouldFail) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/comments")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/branches/")) {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/pulls")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          number: 82,
          state: "open",
          title: "Test",
          html_url: "https://github.com/example/issues/82",
          labels: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const dbPath = createDb();
      const store = new FeatureStore(dbPath);
      store.insertSuggestion({
        githubIssueNumber: 82,
        title: "Test feature",
        description: "desc",
        suggesterDiscordId: "u1",
        suggesterName: "Tester",
        guildId: "g1",
        scopeSummary: null,
      });
      store.setStatus(1, "building");

      const client = makeFakeClient();
      const config = makeFakeConfig();
      const failureCounts = new Map<number, number>();

      await reconcileBuildingSuggestions(client, config, store, "g1", failureCounts);
      expect(failureCounts.get(1)).toBe(1);

      await reconcileBuildingSuggestions(client, config, store, "g1", failureCounts);
      expect(failureCounts.get(1)).toBe(2);

      await reconcileBuildingSuggestions(client, config, store, "g1", failureCounts);
      expect(failureCounts.get(1)).toBe(3);

      shouldFail = false;
      await reconcileBuildingSuggestions(client, config, store, "g1", failureCounts);
      expect(failureCounts.has(1)).toBe(false);

      const suggestion = store.getById(1);
      expect(suggestion?.status).not.toBe("rejected");
    } finally {
      restore();
    }
  });

  test("does not mark rejected before reaching threshold", async () => {
    const restore = patchFetch(() => new Response("", { status: 200 }));

    try {
      const dbPath = createDb();
      const store = new FeatureStore(dbPath);
      store.insertSuggestion({
        githubIssueNumber: 82,
        title: "Test feature",
        description: "desc",
        suggesterDiscordId: "u1",
        suggesterName: "Tester",
        guildId: "g1",
        scopeSummary: null,
      });
      store.setStatus(1, "building");

      const client = makeFakeClient();
      const config = makeFakeConfig();
      const failureCounts = new Map<number, number>();

      for (let i = 0; i < MAX_RECONCILE_FAILURES - 1; i++) {
        await reconcileBuildingSuggestions(client, config, store, "g1", failureCounts);
      }

      const suggestion = store.getById(1);
      expect(suggestion?.status).toBe("building");
      expect(failureCounts.get(1)).toBe(MAX_RECONCILE_FAILURES - 1);
    } finally {
      restore();
    }
  });
});
