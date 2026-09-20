/**
 * Helpers for Bazarr Autopulse-style `?path=` webhooks.
 *
 * Bazarr's `use_external_webhook` GETs the configured URL with a single query
 * param `path` set to the parent directory of the media file (not a JSON
 * body). We resolve that filesystem prefix to Jellyfin items.
 */

export type PathProviderIds = {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
};

/** Pull `[imdb-tt…]` / `[tmdb-…]` / `[tvdb-…]` tags commonly embedded by *arr. */
export function extractProviderIdsFromPath(mediaPath: string): PathProviderIds {
  const out: PathProviderIds = {};
  const imdb = mediaPath.match(/\[imdb-(tt\d+)\]/i);
  if (imdb?.[1]) out.imdbId = imdb[1].toLowerCase();
  const tmdb = mediaPath.match(/\[tmdb-(\d+)\]/i);
  if (tmdb?.[1]) out.tmdbId = Number(tmdb[1]);
  const tvdb = mediaPath.match(/\[tvdb-(\d+)\]/i);
  if (tvdb?.[1]) out.tvdbId = Number(tvdb[1]);
  return out;
}

/** True when `itemPath` is the prefix itself or a file/folder under it. */
export function itemPathMatchesPrefix(itemPath: string, prefix: string): boolean {
  const item = itemPath.replace(/\/+$/, "");
  const pre = prefix.replace(/\/+$/, "");
  if (!pre || !item) return false;
  if (item === pre) return true;
  if (item.startsWith(`${pre}/`)) return true;
  const slash = item.lastIndexOf("/");
  const parent = slash >= 0 ? item.slice(0, slash) : item;
  return parent === pre;
}

/** Strip year + bracket tags so SearchTerm stays Jellyfin-friendly. */
export function pathSearchTerm(mediaPath: string): string {
  const leaf = mediaPath.replace(/\/+$/, "").split("/").pop() ?? "";
  return leaf
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\(\d{4}\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
