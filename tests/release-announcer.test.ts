import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client, TextChannel } from "discord.js";
import { ReleaseAnnouncer } from "../src/release/release-announcer.ts";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jellybot-release-"));
  return join(dir, "bot-state.db");
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
    const announcer = makeAnnouncer(dbPath);
    announcer.getLatestRelease = mock(async () => ({
      tag_name: "v1.0.1",
      name: "v1.0.1",
      body: "fix stuff",
      html_url: "https://example.com",
      published_at: "2026-01-01T00:00:00Z",
    }));

    const client = { channels: { cache: new Map(), fetch: mock(async () => null) } } as unknown as Client;
    await announcer.checkAndAnnounceNewRelease(client);

    const reopened = makeAnnouncer(dbPath);
    reopened.getLatestRelease = announcer.getLatestRelease;
    const tag = await reopened.checkAndAnnounceNewRelease(client);
    expect(tag).toBe("v1.0.1");
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  test("same tag is a no-op", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(join(dbPath, ".."));
    const announcer = makeAnnouncer(dbPath);
    announcer.getLatestRelease = mock(async () => ({
      tag_name: "v2.0.0",
      name: "v2.0.0",
      body: "big release",
      html_url: "https://example.com",
      published_at: "2026-01-01T00:00:00Z",
    }));

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
    announcer.getLatestRelease = mock(async () => ({
      tag_name: "v1.1.0",
      name: "Feature drop",
      body: "- added quotes",
      html_url: "https://example.com/release",
      published_at: "2026-01-01T00:00:00Z",
    }));
    announcer.summarizeReleaseNotes = mock(async (notes: string) => notes);
    announcer.getFeatureCredits = mock(async () => "- clip preview — HeavyGee (@heavygee)");

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
    announcer.getLatestRelease = mock(async () => ({
      tag_name: "v2.0.0",
      name: "Broken channel",
      body: "notes",
      html_url: "https://example.com",
      published_at: "2026-01-01T00:00:00Z",
    }));

    const client = {
      channels: {
        cache: new Map(),
        fetch: mock(async () => null),
      },
    } as unknown as Client;

    await announcer.checkAndAnnounceNewRelease(client);

    const retry = makeAnnouncer(dbPath);
    retry.getLatestRelease = announcer.getLatestRelease;
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
});
