/**
 * Opaque Discord choice values for `/quote from:` (movie or series scope).
 * Labels are display-only; match FTS uses the parsed scope.
 *
 * Series values are `s:<name>` when that fits Discord's 100-char choice limit.
 * Longer names use `se:<episodeItemId>` so the full series_name is recovered
 * from the index (Codex review on #203).
 */

export type QuoteSearchScope =
  | { kind: "series"; seriesName: string }
  | { kind: "seriesByItem"; itemId: string }
  | { kind: "movie"; itemId: string };

export type QuoteFromChoice = {
  kind: "series" | "movie";
  label: string;
  value: string;
};

const DISCORD_CHOICE_MAX = 100;
const SERIES_PREFIX = "s:";
const SERIES_BY_ITEM_PREFIX = "se:";
const MOVIE_PREFIX = "m:";
const ITEM_ID_RE = /^[0-9a-f]{32}$/i;

/** Encode a series scope, falling back to a sample episode id when the name is too long. */
export function encodeQuoteFromSeriesToken(seriesName: string, sampleItemId: string): string {
  const trimmed = seriesName.trim();
  const direct = `${SERIES_PREFIX}${trimmed}`;
  if (direct.length <= DISCORD_CHOICE_MAX) return direct;
  return `${SERIES_BY_ITEM_PREFIX}${sampleItemId.toLowerCase()}`;
}

export function encodeQuoteFromToken(scope: QuoteSearchScope): string {
  if (scope.kind === "series") {
    const direct = `${SERIES_PREFIX}${scope.seriesName.trim()}`;
    if (direct.length <= DISCORD_CHOICE_MAX) return direct;
    throw new Error("series scope name exceeds Discord choice limit; use encodeQuoteFromSeriesToken with sampleItemId");
  }
  if (scope.kind === "seriesByItem") {
    return `${SERIES_BY_ITEM_PREFIX}${scope.itemId.toLowerCase()}`;
  }
  return `${MOVIE_PREFIX}${scope.itemId.toLowerCase()}`;
}

export function parseQuoteFromToken(raw: string): QuoteSearchScope | null {
  const trimmed = raw.trim();
  // Check `se:` before `s:` — both share the leading `s`.
  if (trimmed.startsWith(SERIES_BY_ITEM_PREFIX)) {
    const itemId = trimmed.slice(SERIES_BY_ITEM_PREFIX.length).trim();
    if (!ITEM_ID_RE.test(itemId)) return null;
    return { kind: "seriesByItem", itemId: itemId.toLowerCase() };
  }
  if (trimmed.startsWith(SERIES_PREFIX)) {
    const seriesName = trimmed.slice(SERIES_PREFIX.length).trim();
    if (!seriesName) return null;
    return { kind: "series", seriesName };
  }
  if (trimmed.startsWith(MOVIE_PREFIX)) {
    const itemId = trimmed.slice(MOVIE_PREFIX.length).trim();
    if (!ITEM_ID_RE.test(itemId)) return null;
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
  if (scope.kind === "seriesByItem") return `se:${scope.itemId.toLowerCase()}`;
  return `m:${scope.itemId.toLowerCase()}`;
}

export function displayNameForScope(scope: QuoteSearchScope): string {
  if (scope.kind === "series") return scope.seriesName;
  if (scope.kind === "seriesByItem") return scope.itemId;
  return scope.itemId;
}
