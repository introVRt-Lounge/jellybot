import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQuoteRequestReconcile } from "../src/quote-requests/reconciler.ts";
import { QuoteRequestStore } from "../src/quote-requests/store.ts";
import { openSubtitleIndex } from "../src/subtitles/index-db.ts";

type SentMessage = { channelId: string; content: string; allowedMentions?: unknown };

function makeFakeClient() {
  const sent: SentMessage[] = [];
  return {
    sent,
    client: {
      channels: {
        async fetch(channelId: string) {
          return {
            isTextBased: () => true,
            isDMBased: () => false,
            async send(payload: { content: string; allowedMentions?: unknown }) {
              sent.push({ channelId, ...payload });
              return { id: `msg-${sent.length}` };
            },
          };
        },
      },
    } as unknown as { channels: { fetch(id: string): Promise<unknown> } },
  };
}

describe("runQuoteRequestReconcile", () => {
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

  function tmpPath(prefix: string): string {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    return path;
  }

  test("fulfills a pending wish when its quote becomes indexed", async () => {
    const botStateDbPath = tmpPath("quote-wish-state");
    const subtitleDbPath = tmpPath("quote-wish-subs");

    const store = new QuoteRequestStore(botStateDbPath);
    store.insert({
      requesterDiscordId: "user-7",
      requesterName: "Heavy",
      guildId: "guild-1",
      channelId: "chan-1",
      movieText: "Happy Gilmore",
      quoteText: "I eat pieces of shit like you for breakfast",
    });
    store.close();

    const index = openSubtitleIndex(subtitleDbPath);
    index.replaceItem(
      {
        itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        itemType: "Movie",
        title: "Happy Gilmore",
        productionYear: 1996,
        mediaSourceId: "src",
        subtitleIndex: 2,
      },
      [
        {
          startMs: 60_000,
          endMs: 65_000,
          text: "I eat pieces of shit like you for breakfast",
        },
      ],
    );
    index.close();

    const fake = makeFakeClient();

    await runQuoteRequestReconcile({
      client: fake.client as never,
      config: { botStateDbPath, subtitleDbPath },
    });

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.channelId).toBe("chan-1");
    expect(fake.sent[0]?.content).toContain("<@user-7>");
    expect(fake.sent[0]?.content).toContain("Happy Gilmore");
    expect(fake.sent[0]?.content).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:60000:65000");
    // Issue #144: title + clip-instructions render as Discord subtext (small text).
    expect(fake.sent[0]?.content).toMatch(/^-# .*Happy Gilmore.*Clip it with/m);

    const verify = new QuoteRequestStore(botStateDbPath);
    expect(verify.listPending()).toHaveLength(0);
    verify.close();
  });

  test("leaves pending when no candidate matches the title", async () => {
    const botStateDbPath = tmpPath("quote-wish-state");
    const subtitleDbPath = tmpPath("quote-wish-subs");

    const store = new QuoteRequestStore(botStateDbPath);
    store.insert({
      requesterDiscordId: "u",
      requesterName: "U",
      guildId: "g",
      channelId: "c",
      movieText: "Caddyshack",
      quoteText: "be the ball",
    });
    store.close();

    const index = openSubtitleIndex(subtitleDbPath);
    index.replaceItem(
      {
        itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        itemType: "Movie",
        title: "The Big Lebowski",
        mediaSourceId: "src",
        subtitleIndex: 2,
      },
      [{ startMs: 0, endMs: 1000, text: "be the ball or whatever" }],
    );
    index.close();

    const fake = makeFakeClient();
    await runQuoteRequestReconcile({
      client: fake.client as never,
      config: { botStateDbPath, subtitleDbPath },
    });

    expect(fake.sent).toHaveLength(0);

    const verify = new QuoteRequestStore(botStateDbPath);
    expect(verify.listPending()).toHaveLength(1);
    verify.close();
  });

  test("skips silently when subtitle index db is missing", async () => {
    const botStateDbPath = tmpPath("quote-wish-state");
    const subtitleDbPath = join(tmpdir(), `nonexistent-${Date.now()}.db`);

    const store = new QuoteRequestStore(botStateDbPath);
    store.insert({
      requesterDiscordId: "u",
      requesterName: "U",
      guildId: "g",
      channelId: "c",
      movieText: "Some Movie",
      quoteText: "some line",
    });
    store.close();

    const fake = makeFakeClient();
    await runQuoteRequestReconcile({
      client: fake.client as never,
      config: { botStateDbPath, subtitleDbPath },
    });

    expect(fake.sent).toHaveLength(0);
  });
});
