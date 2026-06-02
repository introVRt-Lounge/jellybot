/**
 * Normalised lookup hint emitted by every parser. The dispatcher uses this to
 * find the matching Jellyfin item, refresh it, then drive the indexer.
 *
 * Shapes:
 * - movie: identified by tmdbId, possibly with imdbId as fallback
 * - episode: identified by tvdbId + season + episode (Sonarr's stable triplet)
 *
 * Unknown / un-actionable events parse to `null` (parser layer) so we don't
 * dispatch them.
 */
export type WebhookKick =
  | {
      kind: "movie";
      source: "radarr" | "bazarr";
      eventType: string;
      tmdbId?: number;
      imdbId?: string;
      /** Optional title for log lines. */
      title?: string;
    }
  | {
      kind: "episode";
      source: "sonarr" | "bazarr";
      eventType: string;
      tvdbId: number;
      seasonNumber: number;
      episodeNumber: number;
      title?: string;
    };

/**
 * Stable de-dup key. Multiple webhooks for the same item coalesce on this.
 * For movies we prefer tmdbId; for episodes we use tvdbId+SxxExx so the same
 * episode arriving via Sonarr and Bazarr collapses into one kick.
 */
export function kickKey(kick: WebhookKick): string {
  if (kick.kind === "movie") {
    if (kick.tmdbId != null) return `movie:tmdb:${kick.tmdbId}`;
    if (kick.imdbId) return `movie:imdb:${kick.imdbId}`;
    return `movie:unknown:${kick.title ?? "?"}`;
  }
  return `episode:tvdb:${kick.tvdbId}:S${kick.seasonNumber}E${kick.episodeNumber}`;
}
