import { describe, expect, test } from "bun:test";
import { SonarrApiError, SonarrClient } from "../src/sonarr/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetch(handler: (url: string, init: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe("SonarrClient", () => {
  test("lookup encodes the term and maps results", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse([
        { tvdbId: 70327, title: "Buffy the Vampire Slayer", year: 1997 },
        { tvdbId: 76690, title: "Buffy the Vampire Slayer: Animated", year: 2002 },
      ]),
    );
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);

    const results = await client.lookup("buffy the vampire slayer");

    expect(calls[0]?.url).toBe(
      "http://sonarr/sonarr/api/v3/series/lookup?term=buffy%20the%20vampire%20slayer",
    );
    expect(calls[0]?.init.headers).toMatchObject({ "X-Api-Key": "key" });
    expect(results).toHaveLength(2);
    expect(results[0]?.tvdbId).toBe(70327);
  });

  test("addSeriesUnmonitored builds the canonical 'add but don't grab' payload", async () => {
    const { fetch, calls } = recordingFetch((url) => {
      if (url.includes("/series/lookup")) {
        return jsonResponse([
          {
            tvdbId: 70327,
            title: "Buffy the Vampire Slayer",
            year: 1997,
            seasons: [
              { seasonNumber: 0, monitored: true },
              { seasonNumber: 1, monitored: true },
              { seasonNumber: 2, monitored: true },
            ],
          },
        ]);
      }
      if (url.endsWith("/api/v3/series")) {
        return jsonResponse(
          { id: 99, tvdbId: 70327, title: "Buffy the Vampire Slayer", monitored: false },
          201,
        );
      }
      throw new Error("unexpected url " + url);
    });
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);

    const series = await client.addSeriesUnmonitored({
      tvdbId: 70327,
      qualityProfileId: 4,
      languageProfileId: 1,
      rootFolderPath: "/data/tv",
    });

    expect(series.id).toBe(99);
    const post = calls.find((c) => c.init.method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post!.init.body));
    expect(body).toMatchObject({
      tvdbId: 70327,
      qualityProfileId: 4,
      languageProfileId: 1,
      rootFolderPath: "/data/tv",
      monitored: false,
      seasonFolder: true,
      addOptions: {
        monitor: "none",
        searchForMissingEpisodes: false,
        searchForCutoffUnmetEpisodes: false,
      },
    });
    // Every catalog season is forced to monitored=false so Sonarr doesn't grab the show.
    expect(body.seasons.every((s: { monitored: boolean }) => s.monitored === false)).toBe(true);
  });

  test("findSeriesByTvdbId returns the matching series or null", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse([
        { id: 1, tvdbId: 1, title: "A", monitored: false },
        { id: 2, tvdbId: 70327, title: "Buffy", monitored: false },
      ]),
    );
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);

    const found = await client.findSeriesByTvdbId(70327);
    expect(found?.id).toBe(2);
    const missing = await client.findSeriesByTvdbId(424242);
    expect(missing).toBeNull();
  });

  test("findEpisode locates a specific season+episode", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse([
        { id: 11, seriesId: 2, seasonNumber: 1, episodeNumber: 1, monitored: false, hasFile: false },
        { id: 12, seriesId: 2, seasonNumber: 1, episodeNumber: 2, monitored: false, hasFile: false },
        { id: 22, seriesId: 2, seasonNumber: 2, episodeNumber: 5, monitored: true, hasFile: true },
      ]),
    );
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);

    const ep = await client.findEpisode(2, 2, 5);
    expect(ep?.id).toBe(22);
    const missing = await client.findEpisode(2, 9, 9);
    expect(missing).toBeNull();
  });

  test("setEpisodeMonitored fetches first then PUTs back with monitored flipped", async () => {
    const { fetch, calls } = recordingFetch((url, init) => {
      if (init.method === "GET" && url.endsWith("/api/v3/episode/22")) {
        return jsonResponse({
          id: 22,
          seriesId: 2,
          seasonNumber: 2,
          episodeNumber: 5,
          monitored: false,
          hasFile: false,
        });
      }
      if (init.method === "PUT" && url.endsWith("/api/v3/episode/22")) {
        return jsonResponse({ ...JSON.parse(String(init.body)), monitored: true });
      }
      throw new Error("unexpected request " + (init.method ?? "GET") + " " + url);
    });
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);

    const updated = await client.setEpisodeMonitored(22, true);
    expect(updated.monitored).toBe(true);
    const put = calls.find((c) => c.init.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put!.init.body))).toMatchObject({ id: 22, monitored: true });
  });

  test("episodeSearch posts an EpisodeSearch command with the ids", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 7, status: "queued" }, 201));
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);

    const result = await client.episodeSearch([22]);
    expect(result.id).toBe(7);

    const post = calls.find((c) => c.init.method === "POST");
    expect(post?.url).toBe("http://sonarr/sonarr/api/v3/command");
    expect(JSON.parse(String(post!.init.body))).toMatchObject({
      name: "EpisodeSearch",
      episodeIds: [22],
    });
  });

  test("languageProfiles returns [] on Sonarr installations that removed the endpoint", async () => {
    const { fetch } = recordingFetch(() => new Response("not found", { status: 404 }));
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);
    await expect(client.languageProfiles()).resolves.toEqual([]);
  });

  test("non-2xx responses raise SonarrApiError with status", async () => {
    const { fetch } = recordingFetch(() => new Response("nope", { status: 401 }));
    const client = new SonarrClient("http://sonarr/sonarr", "key", fetch);
    let caught: unknown;
    try {
      await client.systemStatus();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SonarrApiError);
    expect((caught as SonarrApiError).status).toBe(401);
  });
});
