import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QuoteRequestStore } from "../src/quote-requests/store.ts";

describe("QuoteRequestStore", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  });

  function makeStore(): QuoteRequestStore {
    const path = join(tmpdir(), `quote-wish-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    return new QuoteRequestStore(path);
  }

  test("insert returns row with pending status", () => {
    const store = makeStore();
    const row = store.insert({
      requesterDiscordId: "user-1",
      requesterName: "User One",
      guildId: "guild-a",
      channelId: "chan-1",
      movieText: "Happy Gilmore",
      quoteText: "I eat pieces of shit like you for breakfast",
    });

    expect(row.id).toBeGreaterThan(0);
    expect(row.status).toBe("pending");
    expect(row.movieText).toBe("Happy Gilmore");
    expect(row.fulfilledAt).toBeNull();
    store.close();
  });

  test("listPending returns rows in created_at order", () => {
    const store = makeStore();
    const a = store.insert({
      requesterDiscordId: "u1",
      requesterName: "U1",
      guildId: "g",
      channelId: "c",
      movieText: "Movie A",
      quoteText: "first quote",
    });
    const b = store.insert({
      requesterDiscordId: "u2",
      requesterName: "U2",
      guildId: "g",
      channelId: "c",
      movieText: "Movie B",
      quoteText: "second quote",
    });

    const pending = store.listPending();
    expect(pending.map((r) => r.id)).toEqual([a.id, b.id]);
    store.close();
  });

  test("markFulfilled removes row from pending and stores match metadata", () => {
    const store = makeStore();
    const row = store.insert({
      requesterDiscordId: "u1",
      requesterName: "U1",
      guildId: "g",
      channelId: "c",
      movieText: "Movie",
      quoteText: "quote",
    });

    store.markFulfilled({
      id: row.id,
      itemId: "abc",
      matchToken: "abc:1000:2000",
      notificationMessageId: "msg-9",
    });

    expect(store.listPending()).toHaveLength(0);
    const fetched = store.getById(row.id);
    expect(fetched?.status).toBe("fulfilled");
    expect(fetched?.fulfilledMatchToken).toBe("abc:1000:2000");
    expect(fetched?.fulfilledNotificationMessageId).toBe("msg-9");
    expect(fetched?.fulfilledAt).not.toBeNull();
    store.close();
  });

  test("markFulfilled is a no-op for non-pending rows", () => {
    const store = makeStore();
    const row = store.insert({
      requesterDiscordId: "u",
      requesterName: "U",
      guildId: "g",
      channelId: "c",
      movieText: "M",
      quoteText: "q",
    });

    store.markFulfilled({
      id: row.id,
      itemId: "id-1",
      matchToken: "id-1:0:1",
      notificationMessageId: null,
    });

    store.markFulfilled({
      id: row.id,
      itemId: "id-2",
      matchToken: "id-2:0:1",
      notificationMessageId: "newer",
    });

    const fetched = store.getById(row.id);
    expect(fetched?.fulfilledItemId).toBe("id-1");
    store.close();
  });

  test("countPendingForRequester counts only pending rows", () => {
    const store = makeStore();
    const a = store.insert({
      requesterDiscordId: "u1",
      requesterName: "U1",
      guildId: "g",
      channelId: "c",
      movieText: "A",
      quoteText: "qa",
    });
    store.insert({
      requesterDiscordId: "u1",
      requesterName: "U1",
      guildId: "g",
      channelId: "c",
      movieText: "B",
      quoteText: "qb",
    });
    store.insert({
      requesterDiscordId: "u2",
      requesterName: "U2",
      guildId: "g",
      channelId: "c",
      movieText: "C",
      quoteText: "qc",
    });

    expect(store.countPendingForRequester("u1")).toBe(2);

    store.markFulfilled({
      id: a.id,
      itemId: "x",
      matchToken: "x:0:1",
      notificationMessageId: null,
    });

    expect(store.countPendingForRequester("u1")).toBe(1);
    store.close();
  });

  test("markAbandoned changes status to abandoned", () => {
    const store = makeStore();
    const row = store.insert({
      requesterDiscordId: "u",
      requesterName: "U",
      guildId: "g",
      channelId: "c",
      movieText: "M",
      quoteText: "q",
    });
    store.markAbandoned(row.id);
    expect(store.getById(row.id)?.status).toBe("abandoned");
    expect(store.listPending()).toHaveLength(0);
    store.close();
  });
});
