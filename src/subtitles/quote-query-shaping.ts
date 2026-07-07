import type { QuoteSearchResult } from "./index-db.ts";

/** Minimum token length for "distinctive" quote tokens (shared with quote-request matcher). */
export const DISTINCTIVE_TOKEN_MIN_LENGTH = 4;

/** FTS AND-query minimum token length (matches prepareFtsQuery in index-db). */
export const FTS_QUERY_TOKEN_MIN_LENGTH = 2;

const AUTOCOMPLETE_MAX_FULL_TOKENS = 5;
const AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT = 5;

type QuoteMatchSearchCacheEntry = {
  rawQuery: string;
  searchQuery: string;
  seriesFilter?: string;
  results: QuoteSearchResult[];
};

const quoteMatchSearchCache = new Map<string, QuoteMatchSearchCacheEntry>();

export function extractDistinctiveTokens(quote: string): string[] {
  return tokenizeQuote(quote).filter((token) => token.length >= DISTINCTIVE_TOKEN_MIN_LENGTH);
}

export function extractQueryTokens(quote: string): string[] {
  return tokenizeQuote(quote).filter((token) => token.length >= FTS_QUERY_TOKEN_MIN_LENGTH);
}

/**
 * Shapes long user input for `/quote match:` autocomplete FTS only.
 * Full quotes can AND-join dozens of tokens and stall on multi-million-row FTS;
 * while typing, the trailing distinctive tokens are the discriminating signal.
 */
export function shapeQuoteAutocompleteQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (!trimmed) return trimmed;

  const tokens = extractQueryTokens(trimmed);
  const allTokens = tokenizeQuote(trimmed);
  const activeLastToken = allTokens[allTokens.length - 1] ?? "";

  if (tokens.length <= AUTOCOMPLETE_MAX_FULL_TOKENS) {
    return trimmed;
  }

  let shaped: string;
  const distinctive = extractDistinctiveTokens(trimmed);
  if (distinctive.length === 0) {
    shaped = tokens.slice(-AUTOCOMPLETE_MAX_FULL_TOKENS).join(" ");
  } else if (distinctive.length <= AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT) {
    shaped = distinctive.join(" ");
  } else {
    shaped = distinctive.slice(-AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT).join(" ");
  }

  // Keep the in-progress final token so FTS can prefix-match while the user
  // pauses on a short trailing word (e.g. "fla" at the end of a long quote).
  const earlierTokens = allTokens.slice(0, -1);
  const lastTokenRepeatedEarlier = earlierTokens.includes(activeLastToken);
  if (
    activeLastToken.length >= FTS_QUERY_TOKEN_MIN_LENGTH &&
    activeLastToken.length < DISTINCTIVE_TOKEN_MIN_LENGTH &&
    !shapedIncludesActiveLastToken(shaped, activeLastToken) &&
    !lastTokenRepeatedEarlier
  ) {
    return `${shaped} ${activeLastToken}`.trim();
  }

  return shaped;
}

export function cueTextMatchesQueryTokens(cueText: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return true;

  const cueTokens = tokenizeQuote(cueText);
  for (let index = 0; index < queryTokens.length; index += 1) {
    const queryToken = queryTokens[index]!;
    const isLastToken = index === queryTokens.length - 1;
    const matched = cueTokens.some((cueToken) =>
      isLastToken ? cueToken.startsWith(queryToken) : cueToken === queryToken,
    );
    if (!matched) return false;
  }

  return true;
}

/** True when `nextRaw` only lengthens the final token of `previousRaw`. */
export function isLastTokenPrefixExtension(previousRaw: string, nextRaw: string): boolean {
  const previousTokens = tokenizeQuote(previousRaw);
  const nextTokens = tokenizeQuote(nextRaw);
  if (previousTokens.length === 0 || nextTokens.length === 0) return false;
  if (nextTokens.length !== previousTokens.length) return false;

  for (let index = 0; index < previousTokens.length - 1; index += 1) {
    if (previousTokens[index] !== nextTokens[index]) return false;
  }

  const previousLast = previousTokens[previousTokens.length - 1]!;
  const nextLast = nextTokens[nextTokens.length - 1]!;
  return nextLast.startsWith(previousLast) && nextLast.length > previousLast.length;
}

export function clearQuoteMatchSearchCache(): void {
  quoteMatchSearchCache.clear();
}

export function rememberQuoteMatchSearchCache(
  cacheKey: string,
  rawQuery: string,
  searchQuery: string,
  results: QuoteSearchResult[],
  seriesFilter?: string,
): void {
  if (results.length === 0) return;
  quoteMatchSearchCache.set(cacheKey, { rawQuery, searchQuery, seriesFilter, results });
}

export function tryQuoteMatchPrefixCache(
  cacheKey: string,
  rawQuery: string,
  searchQuery: string,
  seriesFilter?: string,
): QuoteSearchResult[] | null {
  const cached = quoteMatchSearchCache.get(cacheKey);
  if (!cached) return null;

  const cachedSeries = cached.seriesFilter?.toLowerCase() ?? "";
  const activeSeries = seriesFilter?.toLowerCase() ?? "";
  if (cachedSeries !== activeSeries) return null;

  // Only reuse cached rows while refining the final token on both raw and
  // shaped queries. A growing final token can shift the shaped window; if
  // the FTS terms changed, re-query instead of filtering stale top-24 rows.
  if (!isLastTokenPrefixExtension(cached.rawQuery, rawQuery)) {
    return null;
  }
  if (!isLastTokenPrefixExtension(cached.searchQuery, searchQuery)) {
    return null;
  }

  const filterTokens = extractQueryTokens(searchQuery);
  const filtered = cached.results.filter((result) => cueTextMatchesQueryTokens(result.text, filterTokens));
  return filtered.length > 0 ? filtered : null;
}

/** True when the shaped query's final token already covers `activeLastToken`. */
export function shapedIncludesActiveLastToken(shaped: string, activeLastToken: string): boolean {
  const shapedTokens = tokenizeQuote(shaped);
  const lastShaped = shapedTokens[shapedTokens.length - 1] ?? "";
  if (lastShaped === activeLastToken) return true;
  return lastShaped.startsWith(activeLastToken) && lastShaped.length > activeLastToken.length;
}

function tokenizeQuote(quote: string): string[] {
  return quote
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
