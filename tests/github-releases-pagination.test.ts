import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { listReleases, type GitHubRelease } from "../src/release/github-releases.ts";

type Page = Array<Partial<GitHubRelease>>;

function makeRelease(tag: string, overrides: Partial<GitHubRelease> = {}): Partial<GitHubRelease> {
  return {
    tag_name: tag,
    name: tag,
    body: `notes ${tag}`,
    html_url: `https://example/${tag}`,
    published_at: "2026-01-01T00:00:00Z",
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

describe("listReleases pagination (issue #158)", () => {
  let pages: Page[] = [];
  let calls: string[] = [];

  beforeEach(() => {
    pages = [];
    calls = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      calls.push(u);
      const match = /[?&]page=(\d+)/.exec(u);
      const page = match ? parseInt(match[1]!, 10) : 1;
      const body = pages[page - 1] ?? [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("stops at first occurrence of stopTag and reports foundStopTag", async () => {
    pages = [
      [makeRelease("v3.0.0"), makeRelease("v2.5.0"), makeRelease("v2.0.0"), makeRelease("v1.5.0")],
    ];
    const result = await listReleases("o", "r", "t", { stopTag: "v2.0.0", perPage: 4, maxPages: 3 });
    expect(result.foundStopTag).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.releases.map((r) => r.tag_name)).toEqual(["v3.0.0", "v2.5.0", "v2.0.0"]);
    expect(calls.length).toBe(1);
  });

  test("walks across pages until stopTag is found", async () => {
    pages = [
      [makeRelease("v3.0.0"), makeRelease("v2.5.0")],
      [makeRelease("v2.0.0"), makeRelease("v1.5.0")],
    ];
    const result = await listReleases("o", "r", "t", { stopTag: "v2.0.0", perPage: 2, maxPages: 5 });
    expect(result.foundStopTag).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.releases.map((r) => r.tag_name)).toEqual(["v3.0.0", "v2.5.0", "v2.0.0"]);
    expect(calls.length).toBe(2);
  });

  test("reports exhausted when stopTag is not found within maxPages", async () => {
    pages = [
      [makeRelease("v5.0.0"), makeRelease("v4.0.0")],
      [makeRelease("v3.0.0"), makeRelease("v2.0.0")],
    ];
    const result = await listReleases("o", "r", "t", { stopTag: "v0.5.0", perPage: 2, maxPages: 2 });
    expect(result.foundStopTag).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.releases.map((r) => r.tag_name)).toEqual(["v5.0.0", "v4.0.0", "v3.0.0", "v2.0.0"]);
    expect(calls.length).toBe(2);
  });

  test("short page short-circuits to history-exhausted (foundStopTag=true)", async () => {
    // Only one page, fewer items than perPage → API has no more history.
    pages = [[makeRelease("v1.1.0"), makeRelease("v1.0.0")]];
    const result = await listReleases("o", "r", "t", { stopTag: "v0.1.0", perPage: 5, maxPages: 5 });
    expect(result.foundStopTag).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.releases.map((r) => r.tag_name)).toEqual(["v1.1.0", "v1.0.0"]);
    expect(calls.length).toBe(1);
  });

  test("filters out drafts and prereleases across pages", async () => {
    pages = [
      [
        makeRelease("v3.0.0"),
        makeRelease("v3.0.0-rc1", { prerelease: true }),
        makeRelease("draft-tag", { draft: true }),
      ],
      [makeRelease("v2.0.0")],
    ];
    const result = await listReleases("o", "r", "t", { perPage: 3, maxPages: 5 });
    expect(result.releases.map((r) => r.tag_name)).toEqual(["v3.0.0", "v2.0.0"]);
  });

  test("no stopTag walks until short page and reports foundStopTag=true", async () => {
    pages = [
      [makeRelease("v2.0.0"), makeRelease("v1.5.0"), makeRelease("v1.0.0")],
    ];
    const result = await listReleases("o", "r", "t", { perPage: 5, maxPages: 5 });
    expect(result.foundStopTag).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.releases.length).toBe(3);
  });
});
