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
  if (tokens.length <= AUTOCOMPLETE_MAX_FULL_TOKENS) {
    return trimmed;
  }

  const distinctive = extractDistinctiveTokens(trimmed);
  if (distinctive.length === 0) {
    return tokens.slice(-AUTOCOMPLETE_MAX_FULL_TOKENS).join(" ");
  }

  if (distinctive.length <= AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT) {
    return distinctive.join(" ");
  }

  return distinctive.slice(-AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT).join(" ");
}

export function cueTextMatchesQueryTokens(cueText: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return true;
  const haystack = cueText.toLowerCase();
  return queryTokens.every((token) => haystack.includes(token));
}

export function clearQuoteMatchSearchCache(): void {
  quoteMatchSearchCache.clear();
}

export function rememberQuoteMatchSearchCache(
  cacheKey: string,
  rawQuery: string,
  searchQuery: string,
  results: QuoteSearchResult[],
): void {
  if (results.length === 0) return;
  quoteMatchSearchCache.set(cacheKey, { rawQuery, searchQuery, results });
}

export function tryQuoteMatchPrefixCache(
  cacheKey: string,
  rawQuery: string,
  searchQuery: string,
): QuoteSearchResult[] | null {
  const cached = quoteMatchSearchCache.get(cacheKey);
  if (!cached) return null;

  const rawLower = rawQuery.toLowerCase();
  const cachedRawLower = cached.rawQuery.toLowerCase();
  const extendsRaw = rawLower.startsWith(cachedRawLower) && rawLower.length > cachedRawLower.length;
  const extendsSearch =
    searchQuery.toLowerCase().startsWith(cached.searchQuery.toLowerCase()) &&
    searchQuery.length > cached.searchQuery.length;

  if (!extendsRaw && !extendsSearch) {
    return null;
  }

  const filterTokens = extractQueryTokens(rawQuery);
  const filtered = cached.results.filter((result) => cueTextMatchesQueryTokens(result.text, filterTokens));
  return filtered.length > 0 ? filtered : null;
}

function tokenizeQuote(quote: string): string[] {
  return quote
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
