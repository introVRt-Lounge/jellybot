import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  JellyfinClient,
  mediaBrowserClientAuthorization,
  mediaBrowserTokenAuthorization,
} from "../src/jellyfin.ts";

/**
 * Jellyfin 12.0 disables legacy Emby headers by default. Auth must use
 * `Authorization: MediaBrowser …` (issue #198 / Jessica 12.0-rc6 cutover).
 */

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

function headerMap(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url.endsWith("/Users/AuthenticateByName")) {
      return new Response(
        JSON.stringify({
          AccessToken: "live-token",
          User: { Id: "user-1", Name: "fam" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/Users/user-1/Items/")) {
      return new Response(
        JSON.stringify({
          Id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          Name: "Test",
          Type: "Movie",
          MediaSources: [{ Id: "src", MediaStreams: [] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unhandled fetch in test: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Jellyfin 12 MediaBrowser Authorization (#198)", () => {
  test("helper shapes match Jellyfin 12 Authorization scheme", () => {
    expect(mediaBrowserClientAuthorization()).toBe(
      'MediaBrowser Client="jellybot", Device="jellybot", DeviceId="jellybot", Version="1.0.0"',
    );
    expect(mediaBrowserTokenAuthorization("abc")).toBe('MediaBrowser Token="abc"');
  });

  test("AuthenticateByName sends Authorization MediaBrowser client header, not X-Emby-Authorization", async () => {
    const client = new JellyfinClient(
      "http://jellyfin.test",
      "fam",
      "pw",
      "movies",
      "tv",
    );
    await client.authenticate();

    const authCall = fetchCalls.find((c) => c.url.endsWith("/Users/AuthenticateByName"));
    expect(authCall).toBeDefined();
    const headers = headerMap(authCall!.init);
    expect(headers.authorization).toBe(mediaBrowserClientAuthorization());
    expect(headers["x-emby-authorization"]).toBeUndefined();
    expect(JSON.parse(String(authCall!.init?.body))).toEqual({ Username: "fam", Pw: "pw" });
  });

  test("authed GETs send Authorization MediaBrowser Token, not X-Emby-Token", async () => {
    const client = new JellyfinClient(
      "http://jellyfin.test",
      "fam",
      "pw",
      "movies",
      "tv",
    );
    await client.authenticate();
    fetchCalls = [];

    await client.getItem("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(fetchCalls.length).toBeGreaterThan(0);
    const headers = headerMap(fetchCalls[0]!.init);
    expect(headers.authorization).toBe(mediaBrowserTokenAuthorization("live-token"));
    expect(headers["x-emby-token"]).toBeUndefined();
  });
});
