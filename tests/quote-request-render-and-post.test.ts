import { describe, expect, test } from "bun:test";
import { renderAndPostFulfillmentClip } from "../src/quote-requests/render-and-post.ts";
import type { JellyfinClient, JellyfinItem, MediaKind } from "../src/jellyfin.ts";
import type { QuoteRequestRow } from "../src/quote-requests/store.ts";
import type { QuoteRequestMatch } from "../src/quote-requests/matcher.ts";

const config = {
  clipTempDir: "/tmp/jellybot-test-clips",
  maxClipMb: 9,
  maxClipSeconds: 180,
  audioLanguages: "eng,en",
  subtitleLanguages: "eng,en",
  subtitleDefaultClipSeconds: 15,
  subtitleQuotePaddingSeconds: 2,
};

function makeRequest(): QuoteRequestRow {
  return {
    id: 42,
    requesterDiscordId: "user-1",
    requesterName: "User",
    guildId: "guild-1",
    channelId: "chan-1",
    movieText: "Serenity",
    quoteText: "I am a leaf",
    status: "pending",
    fulfilledItemId: null,
    fulfilledMatchToken: null,
    fulfilledNotificationMessageId: null,
    fulfilledAt: null,
    createdAt: "2026-06-02T00:00:00Z",
    acquisitionKind: "radarr",
    acquisitionExternalId: 42,
    acquisitionStatus: "indexed",
    acquisitionMetadata: null,
  };
}

function makeMatch(): QuoteRequestMatch {
  return {
    candidate: {
      itemId: "abc123",
      itemType: "Movie",
      title: "Serenity",
      productionYear: 2005,
      runtimeTicks: 5_280 * 10_000_000, // 88 minutes
      startMs: 60_000,
      endMs: 63_000,
      text: "I am a leaf on the wind. Watch how I soar.",
      rank: -10,
    },
    titleScore: 0.95,
    cueRank: -10,
    confidence: "high",
  };
}

function makeChannelClient(opts: { send: (payload: unknown) => Promise<{ id: string }> }) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          isDMBased: () => false,
          send: async (payload: unknown) => {
            sent.push(payload);
            return opts.send(payload);
          },
        }),
      },
    } as unknown as { channels: { fetch(id: string): Promise<unknown> } },
  };
}

function makeJellyfin(item: JellyfinItem | null): JellyfinClient {
  return {
    getItem: async () => item,
    formatItemLabel: (it: JellyfinItem, _kind?: MediaKind) => `Label: ${it.name}`,
    // Other methods aren't reached when renderClip is stubbed.
  } as unknown as JellyfinClient;
}

describe("renderAndPostFulfillmentClip", () => {
  test("renders the clip and posts MP4 + ping when everything succeeds", async () => {
    const channel = makeChannelClient({
      send: async () => ({ id: "msg-1" }),
    });
    const jellyfin = makeJellyfin({
      id: "abc123",
      name: "Serenity",
      type: "Movie",
      runtimeTicks: 7_080 * 10_000_000,
    });

    const result = await renderAndPostFulfillmentClip({
      client: channel.client as never,
      jellyfin,
      config,
      request: makeRequest(),
      match: makeMatch(),
      renderClipImpl: async () => ({ ok: true, subtitlesBurnedIn: false }),
    });

    expect(result.posted).toBe(true);
    if (!result.posted) throw new Error("expected posted");
    expect(result.messageId).toBe("msg-1");

    expect(channel.sent).toHaveLength(1);
    const payload = channel.sent[0] as { content: string; files: unknown[] };
    expect(payload.content).toContain("<@user-1>");
    expect(payload.content).toContain("your wish is granted");
    expect(payload.content).toContain("I am a leaf");
    // Issue #144: title + "want a different range" must render as Discord subtext (small text).
    expect(payload.content).toMatch(/^-# .*Serenity.*@.*want a different range/m);
    expect(payload.files).toHaveLength(1);
  });

  test("returns posted=false with reason when render fails", async () => {
    const channel = makeChannelClient({ send: async () => ({ id: "should-not-be-called" }) });
    const jellyfin = makeJellyfin({ id: "abc123", name: "Serenity", type: "Movie" });

    const result = await renderAndPostFulfillmentClip({
      client: channel.client as never,
      jellyfin,
      config,
      request: makeRequest(),
      match: makeMatch(),
      renderClipImpl: async () => ({ ok: false, message: "Clip is 12.0 MB, above the 9 MB Discord limit." }),
    });

    expect(result.posted).toBe(false);
    if (result.posted) throw new Error("expected refusal");
    expect(result.reason).toContain("render");
    expect(result.reason).toContain("12.0 MB");
    expect(channel.sent).toHaveLength(0);
  });

  test("returns posted=false when channel is unavailable", async () => {
    const client = {
      channels: {
        fetch: async () => null,
      },
    } as unknown as { channels: { fetch(id: string): Promise<unknown> } };
    const jellyfin = makeJellyfin(null);

    const result = await renderAndPostFulfillmentClip({
      client: client as never,
      jellyfin,
      config,
      request: makeRequest(),
      match: makeMatch(),
      renderClipImpl: async () => ({ ok: true, subtitlesBurnedIn: false }),
    });

    expect(result.posted).toBe(false);
    if (result.posted) throw new Error("expected refusal");
    expect(result.reason).toBe("channel_unavailable");
  });

  test("returns posted=false when Jellyfin no longer has the item", async () => {
    const channel = makeChannelClient({ send: async () => ({ id: "x" }) });
    const jellyfin = makeJellyfin(null);

    const result = await renderAndPostFulfillmentClip({
      client: channel.client as never,
      jellyfin,
      config,
      request: makeRequest(),
      match: makeMatch(),
      renderClipImpl: async () => ({ ok: true, subtitlesBurnedIn: false }),
    });

    expect(result.posted).toBe(false);
    if (result.posted) throw new Error("expected refusal");
    expect(result.reason).toContain("validate");
    expect(channel.sent).toHaveLength(0);
  });

  test("uses 'best guess' wording when confidence is medium", async () => {
    const channel = makeChannelClient({ send: async () => ({ id: "msg-2" }) });
    const jellyfin = makeJellyfin({
      id: "abc123",
      name: "Serenity",
      type: "Movie",
      runtimeTicks: 7_080 * 10_000_000,
    });

    const match = makeMatch();
    match.confidence = "medium";

    const result = await renderAndPostFulfillmentClip({
      client: channel.client as never,
      jellyfin,
      config,
      request: makeRequest(),
      match,
      renderClipImpl: async () => ({ ok: true, subtitlesBurnedIn: false }),
    });

    expect(result.posted).toBe(true);
    const payload = channel.sent[0] as { content: string };
    expect(payload.content.toLowerCase()).toContain("best guess");
  });
});
