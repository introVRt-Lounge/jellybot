import type { WebhookKick } from "./types.ts";

/**
 * Parse a Radarr Connect webhook payload. Radarr v3+ POSTs JSON with shape:
 * {
 *   "eventType": "Test" | "Grab" | "Download" | "Rename" | "MovieFileDelete" | ...
 *   "movie": { "id", "title", "year", "tmdbId", "imdbId", "folderPath" },
 *   "movieFile": { "id", "relativePath", "path", ... },
 *   "isUpgrade": bool
 * }
 *
 * We only act on "Download" (the import-after-grab event) and
 * "MovieFileDelete" / "MovieFileMissing" (re-index in case the file was
 * replaced and we need to drop the old cues). Everything else parses to null.
 */
export function parseRadarrWebhook(raw: unknown): WebhookKick | null {
  if (!isObject(raw)) return null;
  const eventType = stringField(raw, "eventType");
  if (!eventType) return null;
  if (!RADARR_INDEX_EVENTS.has(eventType)) return null;

  const movie = isObject(raw.movie) ? raw.movie : null;
  if (!movie) return null;

  const tmdbId = numberField(movie, "tmdbId");
  const imdbId = stringField(movie, "imdbId") ?? undefined;
  const title = stringField(movie, "title") ?? undefined;

  if (tmdbId == null && !imdbId) return null;

  return {
    kind: "movie",
    source: "radarr",
    eventType,
    tmdbId: tmdbId ?? undefined,
    imdbId,
    title,
  };
}

/**
 * Parse a Sonarr Connect webhook payload. Sonarr v3+ POSTs JSON with shape:
 * {
 *   "eventType": "Test" | "Grab" | "Download" | ...
 *   "series": { "id", "title", "tvdbId", "imdbId", ... },
 *   "episodes": [ { "id", "episodeNumber", "seasonNumber", "title" } ],
 *   "episodeFile": { "id", "relativePath", "path" },
 *   "isUpgrade": bool
 * }
 *
 * Only "Download" (or "OnImport" depending on version) drives indexing. A
 * single payload can list multiple episodes - we dedupe at dispatch time so
 * this returns the first/primary episode and the dispatcher coalesces
 * neighbours.
 */
export function parseSonarrWebhook(raw: unknown): WebhookKick | null {
  if (!isObject(raw)) return null;
  const eventType = stringField(raw, "eventType");
  if (!eventType) return null;
  if (!SONARR_INDEX_EVENTS.has(eventType)) return null;

  const series = isObject(raw.series) ? raw.series : null;
  if (!series) return null;
  const tvdbId = numberField(series, "tvdbId");
  if (tvdbId == null) return null;

  const episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
  const first = episodes.find(isObject);
  if (!first) return null;
  const seasonNumber = numberField(first, "seasonNumber");
  const episodeNumber = numberField(first, "episodeNumber");
  if (seasonNumber == null || episodeNumber == null) return null;

  return {
    kind: "episode",
    source: "sonarr",
    eventType,
    tvdbId,
    seasonNumber,
    episodeNumber,
    title: stringField(series, "title") ?? undefined,
  };
}

/**
 * Parse a Bazarr custom webhook payload. Bazarr's notification schema is less
 * standardised than the *arr stack - depending on the install we may receive
 * either a movie-shaped payload (with tmdbId/imdbId) or a series/episode
 * payload (with tvdbId + season + episode).
 *
 * Behaviour:
 * - If the payload identifies a movie (tmdbId or imdbId): emit a movie kick.
 * - If the payload identifies an episode (tvdbId + S+E numbers): emit an
 *   episode kick.
 * - Otherwise: null. Bazarr fires for many event types we don't care about.
 */
export function parseBazarrWebhook(raw: unknown): WebhookKick | null {
  if (!isObject(raw)) return null;
  const eventType = stringField(raw, "event") ?? stringField(raw, "eventType") ?? "subtitle";

  // Episode shape first - tvdb + season + episode are the most distinctive
  // signals so we don't mis-route a series payload as a movie.
  const tvdbId = numberField(raw, "tvdbId") ?? numberField(raw, "tvdb_id");
  const seasonNumber = numberField(raw, "seasonNumber") ?? numberField(raw, "season");
  const episodeNumber = numberField(raw, "episodeNumber") ?? numberField(raw, "episode");
  if (tvdbId != null && seasonNumber != null && episodeNumber != null) {
    return {
      kind: "episode",
      source: "bazarr",
      eventType,
      tvdbId,
      seasonNumber,
      episodeNumber,
      title:
        stringField(raw, "seriesTitle") ??
        stringField(raw, "series") ??
        stringField(raw, "title") ??
        undefined,
    };
  }

  const tmdbId = numberField(raw, "tmdbId") ?? numberField(raw, "tmdb_id");
  const imdbId = stringField(raw, "imdbId") ?? stringField(raw, "imdb_id") ?? undefined;
  if (tmdbId != null || imdbId) {
    return {
      kind: "movie",
      source: "bazarr",
      eventType,
      tmdbId: tmdbId ?? undefined,
      imdbId,
      title: stringField(raw, "title") ?? undefined,
    };
  }

  return null;
}

const RADARR_INDEX_EVENTS = new Set([
  "Download",
  "Rename",
  "MovieFileDelete",
  "MovieFileMissing",
]);

const SONARR_INDEX_EVENTS = new Set([
  "Download",
  "Rename",
  "EpisodeFileDelete",
  "EpisodeFileDeleteForUpgrade",
  "EpisodeFileMissing",
  "OnImport",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
