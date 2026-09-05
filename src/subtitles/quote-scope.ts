/**
 * Opaque Discord choice values for `/quote from:` (movie or series scope).
 * Labels are display-only; match FTS uses the parsed scope.
 */

export type QuoteSearchScope =
  | { kind: "series"; seriesName: string }
  | { kind: "movie"; itemId: string };

export type QuoteFromChoice = {
  kind: "series" | "movie";
  label: string;
  value: string;
};

const DISCORD_CHOICE_MAX = 100;
const SERIES_PREFIX = "s:";
const MOVIE_PREFIX = "m:";
const MOVIE_ID_RE = /^[0-9a-f]{32}$/i;

export function encodeQuoteFromToken(scope: QuoteSearchScope): string {
  if (scope.kind === "series") {
    const name = scope.seriesName.trim().slice(0, DISCORD_CHOICE_MAX - SERIES_PREFIX.length);
    return `${SERIES_PREFIX}${name}`;
  }
  return `${MOVIE_PREFIX}${scope.itemId.toLowerCase()}`;
}

export function parseQuoteFromToken(raw: string): QuoteSearchScope | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith(SERIES_PREFIX)) {
    const seriesName = trimmed.slice(SERIES_PREFIX.length).trim();
    if (!seriesName) return null;
    return { kind: "series", seriesName };
  }
  if (trimmed.startsWith(MOVIE_PREFIX)) {
    const itemId = trimmed.slice(MOVIE_PREFIX.length).trim();
    if (!MOVIE_ID_RE.test(itemId)) return null;
    return { kind: "movie", itemId: itemId.toLowerCase() };
  }
  return null;
}

export function formatQuoteFromLabel(
  input:
    | { kind: "series"; seriesName: string }
    | { kind: "movie"; title: string; productionYear?: number | null },
): string {
  const raw =
    input.kind === "series"
      ? `TV · ${input.seriesName}`
      : input.productionYear != null
        ? `Movie · ${input.title} (${input.productionYear})`
        : `Movie · ${input.title}`;
  if (raw.length <= DISCORD_CHOICE_MAX) return raw;
  return `${raw.slice(0, DISCORD_CHOICE_MAX - 1)}…`;
}

/** Stable cache / log key for match autocomplete scoped by `from`. */
export function quoteFromScopeCacheKey(scope?: QuoteSearchScope): string {
  if (!scope) return "";
  if (scope.kind === "series") return `s:${scope.seriesName.toLowerCase()}`;
  return `m:${scope.itemId.toLowerCase()}`;
}

export function displayNameForScope(scope: QuoteSearchScope): string {
  if (scope.kind === "series") return scope.seriesName;
  return scope.itemId;
}
