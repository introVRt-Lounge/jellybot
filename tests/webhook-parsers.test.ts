import { describe, expect, test } from "bun:test";
import {
  parseBazarrWebhook,
  parseRadarrWebhook,
  parseSonarrWebhook,
} from "../src/webhooks/parsers.ts";

describe("parseRadarrWebhook", () => {
  test("turns OnImport into a movie kick keyed by tmdbId", () => {
    const kick = parseRadarrWebhook({
      eventType: "Download",
      movie: {
        id: 10808,
        title: "Life of Brian",
        year: 1979,
        tmdbId: 583,
        imdbId: "tt0079470",
      },
      isUpgrade: false,
    });
    expect(kick).toEqual({
      kind: "movie",
      source: "radarr",
      eventType: "Download",
      tmdbId: 583,
      imdbId: "tt0079470",
      title: "Life of Brian",
    });
  });

  test("ignores non-indexable event types like Test/Grab/HealthIssue", () => {
    expect(parseRadarrWebhook({ eventType: "Test", movie: { tmdbId: 1 } })).toBeNull();
    expect(parseRadarrWebhook({ eventType: "Grab", movie: { tmdbId: 1 } })).toBeNull();
    expect(parseRadarrWebhook({ eventType: "HealthIssue" })).toBeNull();
  });

  test("returns null when the movie block has no usable id", () => {
    expect(parseRadarrWebhook({ eventType: "Download", movie: {} })).toBeNull();
    expect(parseRadarrWebhook({ eventType: "Download" })).toBeNull();
  });

  test("rejects garbage input shapes without throwing", () => {
    expect(parseRadarrWebhook(null)).toBeNull();
    expect(parseRadarrWebhook("nope")).toBeNull();
    expect(parseRadarrWebhook([])).toBeNull();
  });

  test("accepts MovieFileDelete so we re-index after a file replace", () => {
    const kick = parseRadarrWebhook({
      eventType: "MovieFileDelete",
      movie: { tmdbId: 583, title: "Life of Brian" },
    });
    expect(kick?.kind).toBe("movie");
    expect(kick?.eventType).toBe("MovieFileDelete");
  });
});

describe("parseSonarrWebhook", () => {
  test("turns Download into an episode kick keyed by tvdb+S+E", () => {
    const kick = parseSonarrWebhook({
      eventType: "Download",
      series: { id: 144, title: "Buffy the Vampire Slayer", tvdbId: 70327 },
      episodes: [
        { id: 12345, episodeNumber: 5, seasonNumber: 2, title: "Reptile Boy" },
      ],
    });
    expect(kick).toEqual({
      kind: "episode",
      source: "sonarr",
      eventType: "Download",
      tvdbId: 70327,
      seasonNumber: 2,
      episodeNumber: 5,
      title: "Buffy the Vampire Slayer",
    });
  });

  test("uses first episode in a multi-episode payload (dispatch coalesces siblings)", () => {
    const kick = parseSonarrWebhook({
      eventType: "Download",
      series: { tvdbId: 1 },
      episodes: [
        { seasonNumber: 1, episodeNumber: 5 },
        { seasonNumber: 1, episodeNumber: 6 },
      ],
    });
    expect(kick?.kind).toBe("episode");
    if (kick?.kind !== "episode") return;
    expect(kick.seasonNumber).toBe(1);
    expect(kick.episodeNumber).toBe(5);
  });

  test("returns null when tvdbId is missing", () => {
    expect(
      parseSonarrWebhook({
        eventType: "Download",
        series: { title: "X" },
        episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
      }),
    ).toBeNull();
  });

  test("ignores non-indexable events", () => {
    expect(
      parseSonarrWebhook({
        eventType: "Test",
        series: { tvdbId: 1 },
        episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
      }),
    ).toBeNull();
  });
});

describe("parseBazarrWebhook", () => {
  test("episode shape wins when tvdb + season + episode are all present", () => {
    const kick = parseBazarrWebhook({
      event: "subtitle_downloaded",
      tvdbId: 70327,
      seasonNumber: 2,
      episodeNumber: 5,
      seriesTitle: "Buffy",
    });
    expect(kick).toEqual({
      kind: "episode",
      source: "bazarr",
      eventType: "subtitle_downloaded",
      tvdbId: 70327,
      seasonNumber: 2,
      episodeNumber: 5,
      title: "Buffy",
    });
  });

  test("snake_case keys are accepted (bazarr custom-webhook variants)", () => {
    const kick = parseBazarrWebhook({
      event: "downloaded",
      tvdb_id: 100,
      season: 3,
      episode: 7,
      title: "Whatever",
    });
    expect(kick?.kind).toBe("episode");
  });

  test("falls back to movie shape when no episode signals exist", () => {
    const kick = parseBazarrWebhook({
      event: "subtitle_downloaded",
      tmdbId: 583,
      title: "Life of Brian",
    });
    expect(kick).toEqual({
      kind: "movie",
      source: "bazarr",
      eventType: "subtitle_downloaded",
      tmdbId: 583,
      imdbId: undefined,
      title: "Life of Brian",
    });
  });

  test("returns null on payloads with no usable identifier", () => {
    expect(parseBazarrWebhook({ event: "x", title: "ambiguous" })).toBeNull();
    expect(parseBazarrWebhook({})).toBeNull();
  });
});
