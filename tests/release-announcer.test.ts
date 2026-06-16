import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client, TextChannel } from "discord.js";
import { BotStateStore } from "../src/release/bot-state.ts";
import { ReleaseAnnouncer } from "../src/release/release-announcer.ts";
import type { GitHubRelease, ListReleasesResult } from "../src/release/github-releases.ts";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jellybot-release-"));
  return join(dir, "bot-state.db");
}

function fakeRelease(tag: string, body = `notes for ${tag}`): GitHubRelease {
  return {
    tag_name: tag,
    name: tag,
    body,
    html_url: `https://example.com/${tag}`,
    published_at: "2026-01-01T00:00:00Z",
  };
}

function fakeListing(releases: GitHubRelease[], opts: Partial<ListReleasesResult> = {}): ListReleasesResult {
  return {
    releases,
    foundStopTag: opts.foundStopTag ?? true,
    exhausted: opts.exhausted ?? false,
  };
}

function makeAnnouncer(dbPath: string): ReleaseAnnouncer {
  const announcer = new ReleaseAnnouncer({
    githubToken: "test-token",
    repoOwner: "introVRt-Lounge",
    repoName: "jellybot",
    notificationChannelId: "1159798255295660103",
    gracePeriodMs: 0,
    botStateDbPath: dbPath,
  });
  announcer.getFeatureCredits = mock(async () => null);
  return announcer;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  mock.restore();
});

describe("ReleaseAnnouncer", () => {
  test("patch release updates DB silently without posting", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    // Seed lastAnnounced=v1.0.0 so v1.0.1 is the only thing in the gap.
    const seed = new BotStateStore(dbPath);
    seed.setLastAnnouncedRelease("v1.0.0");
    seed.close();

    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () => fakeListing([fakeRelease("v1.0.1", "fix stuff"), fakeRelease("v1.0.0")]));

    const client = { channels: { cache: new Map(), fetch: mock(async () => null) } } as unknown as Client;
    await announcer.checkAndAnnounceNewRelease(client);

    const reopened = makeAnnouncer(dbPath);
    reopened.listReleases = announcer.listReleases;
    const tag = await reopened.checkAndAnnounceNewRelease(client);
    expect(tag).toBe("v1.0.1");
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  test("same tag is a no-op", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () => fakeListing([fakeRelease("v2.0.0", "big release")]));

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    await announcer.checkAndAnnounceNewRelease(client);
    await announcer.checkAndAnnounceNewRelease(client);

    expect(send).toHaveBeenCalledTimes(1);
  });

  test("major/minor release posts an embed", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () =>
      fakeListing([
        Object.assign(fakeRelease("v1.1.0", "- added quotes"), { name: "Feature drop", html_url: "https://example.com/release" }),
      ]),
    );
    announcer.summarizeReleaseNotes = mock(async (notes: string) => notes);
    announcer.getFeatureCredits = mock(async () => "- clip preview - HeavyGee (@heavygee)");

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    await announcer.checkAndAnnounceNewRelease(client);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { embeds: Array<{ data: { fields?: Array<{ name: string }> } }> };
    const fieldNames = payload.embeds[0]?.data.fields?.map((field) => field.name) ?? [];
    expect(fieldNames).toContain("Feature credits");
  });

  test("missing channel does not persist announcement", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () => fakeListing([fakeRelease("v2.0.0", "notes")]));

    const client = {
      channels: {
        cache: new Map(),
        fetch: mock(async () => null),
      },
    } as unknown as Client;

    await announcer.checkAndAnnounceNewRelease(client);

    const retry = makeAnnouncer(dbPath);
    retry.listReleases = announcer.listReleases;
    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const retryClient = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    await retry.checkAndAnnounceNewRelease(retryClient);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("walks gap and announces the highest non-patch when latest is a patch (issue #156)", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));

    // Reproduces the v1.16.1 → v1.17.1 incident: feat in gap, patch on top.
    const seed = new BotStateStore(dbPath);
    seed.setLastAnnouncedRelease("v1.16.1");
    seed.close();

    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () =>
      fakeListing([
        fakeRelease("v1.17.1", "fix follow-up"),
        fakeRelease("v1.17.0", "feat: /quote series: param"),
        fakeRelease("v1.16.2", "fix: hyphen tokenization"),
        fakeRelease("v1.16.1"),
      ]),
    );
    announcer.summarizeReleaseNotes = mock(async (notes: string) => notes);

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    const tag = await announcer.checkAndAnnounceNewRelease(client);
    expect(tag).toBe("v1.17.1");
    expect(send).toHaveBeenCalledTimes(1);

    const payload = send.mock.calls[0]?.[0] as { embeds: Array<{ data: { title?: string } }> };
    expect(payload.embeds[0]?.data.title).toContain("v1.17.0");

    // Subsequent run is a no-op even though latest is still v1.17.1.
    const followUp = makeAnnouncer(dbPath);
    followUp.listReleases = announcer.listReleases;
    await followUp.checkAndAnnounceNewRelease(client);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("gap with only patches marks silent and does not post (issue #156)", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    const seed = new BotStateStore(dbPath);
    seed.setLastAnnouncedRelease("v2.0.0");
    seed.close();

    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () =>
      fakeListing([fakeRelease("v2.0.2"), fakeRelease("v2.0.1"), fakeRelease("v2.0.0")]),
    );

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    const tag = await announcer.checkAndAnnounceNewRelease(client);
    expect(tag).toBe("v2.0.2");
    expect(send).not.toHaveBeenCalled();

    // DB is now stamped at v2.0.2 so the next run is a clean no-op.
    const next = makeAnnouncer(dbPath);
    next.listReleases = mock(async () =>
      fakeListing([fakeRelease("v2.0.2"), fakeRelease("v2.0.1"), fakeRelease("v2.0.0")]),
    );
    const tag2 = await next.checkAndAnnounceNewRelease(client);
    expect(tag2).toBe("v2.0.2");
    expect(send).not.toHaveBeenCalled();
  });

  test("refuses to act when page cap is exhausted without finding lastAnnouncedTag (issue #158)", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));

    // Bot was offline for far more releases than fit in the walked window.
    // listReleases comes back exhausted with the visible window starting
    // at v1.5.0; the stored tag v1.0.0 lives somewhere older. Stamping
    // anything in this window would either skip the unseen older feats
    // (stamp latest) or cause re-announcement (stamp oldestVisible).
    // Refuse to act and surface a critical log.
    const seed = new BotStateStore(dbPath);
    seed.setLastAnnouncedRelease("v1.0.0");
    seed.close();

    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () =>
      fakeListing(
        [
          fakeRelease("v2.0.0", "feat: shiny new"),
          fakeRelease("v1.9.0"),
          fakeRelease("v1.8.0"),
          fakeRelease("v1.7.0"),
          fakeRelease("v1.6.0"),
          fakeRelease("v1.5.0"),
        ],
        { foundStopTag: false, exhausted: true },
      ),
    );
    announcer.summarizeReleaseNotes = mock(async (notes: string) => notes);

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    const tag = await announcer.checkAndAnnounceNewRelease(client);
    expect(tag).toBeNull();
    expect(send).not.toHaveBeenCalled();

    // DB stamp untouched at v1.0.0 - operator decides next move.
    const dbAfter = new BotStateStore(dbPath);
    expect(dbAfter.getLastAnnouncedRelease()).toBe("v1.0.0");
    dbAfter.close();
  });

  test("exhausted listing on first run (no lastAnnouncedTag) still announces normally (issue #158)", async () => {
    // First-run case: lastAnnouncedTag is null, so there's nothing to
    // stop-tag-search for. Even if the API returns exhausted=true, the
    // gap is "everything visible" and we can safely act on it.
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));

    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () =>
      fakeListing([fakeRelease("v1.1.0", "feat"), fakeRelease("v1.0.0")], {
        foundStopTag: false,
        exhausted: true,
      }),
    );
    announcer.summarizeReleaseNotes = mock(async (notes: string) => notes);

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    const tag = await announcer.checkAndAnnounceNewRelease(client);
    expect(tag).toBe("v1.1.0");
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("first run with no last-announced tag treats every visible release as the gap", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    const announcer = makeAnnouncer(dbPath);
    announcer.listReleases = mock(async () => fakeListing([fakeRelease("v1.0.1"), fakeRelease("v1.0.0")]));
    announcer.summarizeReleaseNotes = mock(async (notes: string) => notes);

    const send = mock(async () => undefined);
    const channel = { isTextBased: () => true, send } as unknown as TextChannel;
    const client = {
      channels: {
        cache: new Map([["1159798255295660103", channel]]),
        fetch: mock(async () => channel),
      },
    } as unknown as Client;

    const tag = await announcer.checkAndAnnounceNewRelease(client);
    expect(tag).toBe("v1.0.1");
    // v1.0.0 is the highest non-patch in the gap; it gets announced.
    const payload = send.mock.calls[0]?.[0] as { embeds: Array<{ data: { title?: string } }> };
    expect(payload.embeds[0]?.data.title).toContain("v1.0.0");
  });
});
