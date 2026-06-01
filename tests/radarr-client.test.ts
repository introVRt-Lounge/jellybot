import { describe, expect, test } from "bun:test";
import { RadarrApiError, RadarrClient } from "../src/radarr/client.ts";

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

describe("RadarrClient", () => {
  test("lookup encodes the query and returns mapped results", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse([
        { tmdbId: 11814, title: "Weird Science", year: 1985 },
        { tmdbId: 816839, title: "Weird Science", year: 2002 },
      ]),
    );
    const client = new RadarrClient("http://radarr/radarr", "key", fetch);

    const results = await client.lookup("weird science");

    expect(calls[0]?.url).toBe("http://radarr/radarr/api/v3/movie/lookup?term=weird%20science");
    expect(calls[0]?.init.headers).toMatchObject({ "X-Api-Key": "key" });
    expect(results).toHaveLength(2);
    expect(results[0]?.tmdbId).toBe(11814);
    expect(results[0]?.year).toBe(1985);
  });

  test("addMovie posts the correct payload after a tmdb lookup", async () => {
    const { fetch, calls } = recordingFetch((url) => {
      if (url.includes("/movie/lookup")) {
        return jsonResponse([{ tmdbId: 11814, title: "Weird Science", year: 1985 }]);
      }
      if (url.endsWith("/api/v3/movie")) {
        return jsonResponse({ id: 42, tmdbId: 11814, title: "Weird Science", year: 1985, hasFile: false, monitored: true }, 201);
      }
      throw new Error("unexpected url " + url);
    });
    const client = new RadarrClient("http://radarr/radarr", "key", fetch);

    const movie = await client.addMovie({
      tmdbId: 11814,
      qualityProfileId: 10,
      rootFolderPath: "/data/movies",
      monitored: true,
      searchOnAdd: true,
    });

    expect(movie.id).toBe(42);
    const post = calls.find((c) => c.init.method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post!.init.body));
    expect(body).toMatchObject({
      tmdbId: 11814,
      qualityProfileId: 10,
      rootFolderPath: "/data/movies",
      monitored: true,
      addOptions: { searchForMovie: true, monitor: "movieOnly" },
      minimumAvailability: "released",
    });
  });

  test("non-2xx response raises RadarrApiError with status", async () => {
    const { fetch } = recordingFetch(() =>
      new Response("not allowed", { status: 401 }),
    );
    const client = new RadarrClient("http://radarr/radarr", "key", fetch);
    let caught: unknown;
    try {
      await client.systemStatus();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RadarrApiError);
    expect((caught as RadarrApiError).status).toBe(401);
  });

  test("getMovie returns the parsed payload", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ id: 42, tmdbId: 11814, title: "Weird Science", year: 1985, hasFile: true, monitored: true, movieFile: { path: "/data/movies/Weird.mkv" } }),
    );
    const client = new RadarrClient("http://radarr/radarr", "key", fetch);
    const movie = await client.getMovie(42);
    expect(movie.hasFile).toBe(true);
    expect(movie.movieFile?.path).toBe("/data/movies/Weird.mkv");
  });
});
