import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JellyfinClient } from "../src/jellyfin.ts";

// Issue #126: Jellyfin 10.x silently ignores `AnyProviderIdEquals` on /Items.
// These tests assert that the new lookup methods:
//   1. Do NOT issue an `AnyProviderIdEquals` request.
//   2. DO issue the correct two-step (search-then-filter / series-then-episode) shape.
//   3. Pull the right Jellyfin item id back from a server response that carries
//      the entire library's worth of unrelated entries.

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function urlMatches(url: string, path: string, params: Record<string, string>): boolean {
  if (!url.includes(path)) return false;
  const sp = new URL(url).searchParams;
  for (const [k, v] of Object.entries(params)) {
    if (sp.get(k) !== v) return false;
  }
  return true;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const FAKE_AUTH = {
  AccessToken: "test-token",
  User: { Id: "test-user", Name: "tester" },
};

const FAKE_USER_ID = "test-user";

const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> | Response;

function installFetchStub() {
  fetchCalls = [];
  fetchHandler = (_url, _init) => {
    throw new Error(`unhandled fetch in test: ${_url}`);
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url.endsWith("/Users/AuthenticateByName")) {
      return jsonResponse(FAKE_AUTH);
    }
    return await fetchHandler(url, init);
  }) as typeof fetch;
}

async function makeAuthedClient(): Promise<JellyfinClient> {
  const client = new JellyfinClient(
    "http://jellyfin.test",
    "tester",
    "pw",
    "movies-lib",
    "tv-lib",
  );
  await client.authenticate();
  return client;
}

beforeEach(installFetchStub);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("findItemByTmdbId (#126)", () => {
  test("title hint: server-side searchTerm + client-side ProviderIds.Tmdb filter", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      // Verify the title-search shape exactly.
      if (
        urlMatches(url, "/Items", {
          IncludeItemTypes: "Movie",
          Recursive: "true",
          SearchTerm: "Life of Brian",
          UserId: FAKE_USER_ID,
        }) &&
        !url.includes("AnyProviderIdEquals")
      ) {
        return jsonResponse({
          TotalRecordCount: 2,
          Items: [
            {
              Id: "wrong-id",
              Name: "Life of Brian: Behind the Scenes",
              Type: "Movie",
              ProviderIds: { Tmdb: "999" },
            },
            {
              Id: "lob-id",
              Name: "Life of Brian",
              Type: "Movie",
              ProductionYear: 1979,
              ProviderIds: { Tmdb: "583", Imdb: "tt0079470" },
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = await client.findItemByTmdbId(583, { title: "Life of Brian" });
    expect(item?.id).toBe("lob-id");
    expect(item?.name).toBe("Life of Brian");
    // No AnyProviderIdEquals anywhere.
    expect(fetchCalls.every((c) => !c.url.includes("AnyProviderIdEquals"))).toBe(true);
  });

  test("title hint that returns nothing falls through to paged HasTmdbId walk", async () => {
    const client = await makeAuthedClient();
    let pagedHits = 0;

    fetchHandler = (url) => {
      if (url.includes("SearchTerm=")) {
        return jsonResponse({ TotalRecordCount: 0, Items: [] });
      }
      if (urlMatches(url, "/Items", { HasTmdbId: "true", IncludeItemTypes: "Movie" })) {
        pagedHits += 1;
        const startIndex = new URL(url).searchParams.get("StartIndex");
        if (startIndex === "0") {
          return jsonResponse({
            TotalRecordCount: 250,
            Items: Array.from({ length: 200 }, (_, i) => ({
              Id: `bulk-${i}`,
              Name: `Movie ${i}`,
              Type: "Movie",
              ProviderIds: { Tmdb: String(10000 + i) },
            })),
          });
        }
        return jsonResponse({
          TotalRecordCount: 250,
          Items: [
            {
              Id: "lob-id",
              Name: "Life of Brian",
              Type: "Movie",
              ProviderIds: { Tmdb: "583" },
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = await client.findItemByTmdbId(583, { title: "Nonexistent" });
    expect(item?.id).toBe("lob-id");
    expect(pagedHits).toBe(2);
  });

  test("no hint: starts directly with paged HasTmdbId walk", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      if (urlMatches(url, "/Items", { HasTmdbId: "true" })) {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "match-id",
              Name: "Random Movie",
              Type: "Movie",
              ProviderIds: { Tmdb: "583" },
            },
          ],
        });
      }
      throw new Error(`unexpected url without hint: ${url}`);
    };

    const item = await client.findItemByTmdbId(583);
    expect(item?.id).toBe("match-id");
    expect(fetchCalls.some((c) => c.url.includes("SearchTerm="))).toBe(false);
  });

  test("returns null when neither title-search nor paged walk find the tmdb id", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      if (url.includes("SearchTerm=")) {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "wrong",
              Name: "Some other movie",
              Type: "Movie",
              ProviderIds: { Tmdb: "111" },
            },
          ],
        });
      }
      if (urlMatches(url, "/Items", { HasTmdbId: "true" })) {
        return jsonResponse({ TotalRecordCount: 0, Items: [] });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = await client.findItemByTmdbId(583, { title: "Some Other Movie" });
    expect(item).toBeNull();
  });
});

describe("findEpisodeByTvdb (#126)", () => {
  test("series-title hint -> series lookup -> episode by ParentId+S/E", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      if (
        urlMatches(url, "/Items", {
          IncludeItemTypes: "Series",
          SearchTerm: "Buffy",
        })
      ) {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "buffy-series",
              Name: "Buffy the Vampire Slayer",
              Type: "Series",
              ProviderIds: { Tvdb: "70327", Tmdb: "95" },
            },
          ],
        });
      }
      if (
        urlMatches(url, "/Items", {
          ParentId: "buffy-series",
          IncludeItemTypes: "Episode",
          ParentIndexNumber: "4",
          IndexNumber: "3",
        })
      ) {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "buffy-s4e3",
              Name: "The Harsh Light of Day",
              Type: "Episode",
              ParentIndexNumber: 4,
              IndexNumber: 3,
              SeriesName: "Buffy the Vampire Slayer",
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = await client.findEpisodeByTvdb(70327, 4, 3, { seriesTitle: "Buffy" });
    expect(item?.id).toBe("buffy-s4e3");
    expect(item?.seasonNumber).toBe(4);
    expect(item?.episodeNumber).toBe(3);
    // The big regression: never use AnyProviderIdEquals.
    expect(fetchCalls.every((c) => !c.url.includes("AnyProviderIdEquals"))).toBe(true);
  });

  test("series title-search miss falls through to paged HasTvdbId walk", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      const sp = new URL(url).searchParams;
      if (
        sp.get("IncludeItemTypes") === "Series" &&
        sp.get("SearchTerm") === "Bogus"
      ) {
        return jsonResponse({ TotalRecordCount: 0, Items: [] });
      }
      if (sp.get("IncludeItemTypes") === "Series" && sp.get("HasTvdbId") === "true") {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "buffy-series",
              Name: "Buffy the Vampire Slayer",
              Type: "Series",
              ProviderIds: { Tvdb: "70327" },
            },
          ],
        });
      }
      if (
        sp.get("ParentId") === "buffy-series" &&
        sp.get("ParentIndexNumber") === "4" &&
        sp.get("IndexNumber") === "3"
      ) {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "buffy-s4e3",
              Name: "The Harsh Light of Day",
              Type: "Episode",
              ParentIndexNumber: 4,
              IndexNumber: 3,
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = await client.findEpisodeByTvdb(70327, 4, 3, { seriesTitle: "Bogus" });
    expect(item?.id).toBe("buffy-s4e3");
  });

  test("returns null when the series isn't in the library", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      const sp = new URL(url).searchParams;
      if (sp.get("IncludeItemTypes") === "Series") {
        return jsonResponse({ TotalRecordCount: 0, Items: [] });
      }
      throw new Error(`unexpected url after series miss: ${url}`);
    };

    const item = await client.findEpisodeByTvdb(70327, 4, 3, { seriesTitle: "Buffy" });
    expect(item).toBeNull();
  });

  test("returns null when the series exists but the episode row is missing", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      const sp = new URL(url).searchParams;
      if (sp.get("IncludeItemTypes") === "Series") {
        return jsonResponse({
          TotalRecordCount: 1,
          Items: [
            {
              Id: "buffy-series",
              Name: "Buffy the Vampire Slayer",
              Type: "Series",
              ProviderIds: { Tvdb: "70327" },
            },
          ],
        });
      }
      if (sp.get("IncludeItemTypes") === "Episode") {
        return jsonResponse({ TotalRecordCount: 0, Items: [] });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = await client.findEpisodeByTvdb(70327, 4, 3, { seriesTitle: "Buffy" });
    expect(item).toBeNull();
  });
});

describe("findSeriesByTvdbId (#126)", () => {
  test("title hint resolves to the series with matching ProviderIds.Tvdb", async () => {
    const client = await makeAuthedClient();

    fetchHandler = (url) => {
      const sp = new URL(url).searchParams;
      if (sp.get("IncludeItemTypes") === "Series" && sp.get("SearchTerm") === "Buffy") {
        return jsonResponse({
          TotalRecordCount: 2,
          Items: [
            {
              Id: "wrong-series",
              Name: "Buffy: The Animated Series",
              Type: "Series",
              ProviderIds: { Tvdb: "111" },
            },
            {
              Id: "buffy-series",
              Name: "Buffy the Vampire Slayer",
              Type: "Series",
              ProviderIds: { Tvdb: "70327" },
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const series = await client.findSeriesByTvdbId(70327, { seriesTitle: "Buffy" });
    expect(series?.id).toBe("buffy-series");
  });
});
