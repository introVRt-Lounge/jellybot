import type { FtsMatchMode, QuoteSearchResult } from "./index-db.ts";

/** Minimum token length for "distinctive" quote tokens (shared with quote-request matcher). */
export const DISTINCTIVE_TOKEN_MIN_LENGTH = 4;

/** FTS AND-query minimum token length (matches prepareFtsQuery in index-db). */
export const FTS_QUERY_TOKEN_MIN_LENGTH = 2;

/** Short spoken lines stay contiguous — use FTS5 phrase match (#228). */
export const AUTOCOMPLETE_MAX_FULL_TOKENS = 5;
const AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT = 5;

/**
 * Function words that make autocomplete FTS slow when AND-joined across the
 * full cue index (issue #216). Applied only in {@link shapeQuoteAutocompleteQuery}
 * so `/supercut` / submit search keep exact stop-word semantics.
 */
const AUTOCOMPLETE_FTS_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "do",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "up",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

type QuoteMatchSearchCacheEntry = {
  rawQuery: string;
  searchQuery: string;
  scopeKey?: string;
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
 * Short spoken lines (≤ {@link AUTOCOMPLETE_MAX_FULL_TOKENS}) are contiguous —
 * phrase FTS. Longer input is shaped to non-adjacent distinctive tokens — AND.
 */
export function quoteAutocompleteFtsMode(rawQuery: string): FtsMatchMode {
  const tokens = extractQueryTokens(rawQuery);
  if (tokens.length === 0) return "and";
  return tokens.length <= AUTOCOMPLETE_MAX_FULL_TOKENS ? "phrase" : "and";
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

  let shaped: string;
  if (tokens.length <= AUTOCOMPLETE_MAX_FULL_TOKENS) {
    // Short spoken lines: only strip stops when ≥2 content tokens remain (#222).
    shaped = dropAutocompleteStopWords(tokens, 2).join(" ") || trimmed;
  } else {
    const distinctive = extractDistinctiveTokens(trimmed);
    if (distinctive.length === 0) {
      shaped = tokens.slice(-AUTOCOMPLETE_MAX_FULL_TOKENS).join(" ");
    } else if (distinctive.length <= AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT) {
      shaped = distinctive.join(" ");
    } else {
      shaped = distinctive.slice(-AUTOCOMPLETE_TAIL_DISTINCTIVE_COUNT).join(" ");
    }
    // Long-quote distinctive window already picked content-ish tokens; drop
    // leftover stops even if a single content token remains (#171 / #216).
    shaped = dropAutocompleteStopWords(extractQueryTokens(shaped), 1).join(" ") || shaped;
  }

  // Keep the in-progress final token so FTS can prefix-match while the user
  // pauses on a short trailing word (e.g. "fla" at the end of a long quote).
  // Do not re-append stop words we just dropped (#216).
  const earlierTokens = allTokens.slice(0, -1);
  const lastTokenRepeatedEarlier = earlierTokens.includes(activeLastToken);
  if (
    activeLastToken.length >= FTS_QUERY_TOKEN_MIN_LENGTH &&
    activeLastToken.length < DISTINCTIVE_TOKEN_MIN_LENGTH &&
    !AUTOCOMPLETE_FTS_STOP_WORDS.has(activeLastToken) &&
    !shapedIncludesActiveLastToken(shaped, activeLastToken) &&
    !lastTokenRepeatedEarlier
  ) {
    return `${shaped} ${activeLastToken}`.trim();
  }

  return shaped;
}

/**
 * Drop stop words when at least `minContent` content tokens remain.
 * Short lines use minContent=2 so "are they heavy" does not collapse to "heavy" (#222).
 * Long distinctive tails use minContent=1 (prior #216 behaviour on the trimmed window).
 */
function dropAutocompleteStopWords(tokens: string[], minContent: number): string[] {
  const kept = tokens.filter((token) => !AUTOCOMPLETE_FTS_STOP_WORDS.has(token));
  if (kept.length >= minContent) return kept;
  return tokens;
}

export function cueTextMatchesQueryTokens(cueText: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return true;

  const cueTokens = expandCueTokensForFtsMatch(cueText);
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

/**
 * After stop-word-stripped FTS (#216), short fragments can outrank the exact cue.
 * Re-score candidates by how many **raw** query tokens appear in the cue text
 * (including stop words), then fall back to bm25 (`rank`, lower is better) (#220).
 */
export function rankQuoteAutocompleteResults(
  rawQuery: string,
  results: QuoteSearchResult[],
): QuoteSearchResult[] {
  if (results.length <= 1) return results;

  const queryTokens = extractQueryTokens(rawQuery);
  if (queryTokens.length === 0) return results;
  const normalizedQuery = normalizeQuotePhrase(rawQuery);

  return [...results].sort((left, right) => {
    // Exact / near-exact phrase beats bag-of-token ties (#222 Jurassic Park).
    const leftPhrase = Number(normalizeQuotePhrase(left.text).includes(normalizedQuery));
    const rightPhrase = Number(normalizeQuotePhrase(right.text).includes(normalizedQuery));
    if (rightPhrase !== leftPhrase) return rightPhrase - leftPhrase;

    const leftOverlap = rawCueTokenOverlap(queryTokens, left.text);
    const rightOverlap = rawCueTokenOverlap(queryTokens, right.text);
    if (rightOverlap !== leftOverlap) return rightOverlap - leftOverlap;
    return left.rank - right.rank;
  });
}

function normalizeQuotePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawCueTokenOverlap(queryTokens: string[], cueText: string): number {
  const cueTokens = expandCueTokensForFtsMatch(cueText);
  let matched = 0;
  for (let index = 0; index < queryTokens.length; index += 1) {
    const queryToken = queryTokens[index]!;
    const isLastToken = index === queryTokens.length - 1;
    const hit = cueTokens.some((cueToken) =>
      isLastToken ? cueToken.startsWith(queryToken) : cueToken === queryToken,
    );
    if (hit) matched += 1;
  }
  return matched;
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
  scopeKey?: string,
): void {
  if (results.length === 0) return;
  quoteMatchSearchCache.set(cacheKey, { rawQuery, searchQuery, scopeKey, results });
}

export function tryQuoteMatchPrefixCache(
  cacheKey: string,
  rawQuery: string,
  searchQuery: string,
  scopeKey?: string,
): QuoteSearchResult[] | null {
  const cached = quoteMatchSearchCache.get(cacheKey);
  if (!cached) return null;

  const cachedScope = cached.scopeKey ?? "";
  const activeScope = scopeKey ?? "";
  if (cachedScope !== activeScope) return null;

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

/** True when the shaped query's final token exactly equals `activeLastToken`. */
export function shapedIncludesActiveLastToken(shaped: string, activeLastToken: string): boolean {
  const shapedTokens = tokenizeQuote(shaped);
  const lastShaped = shapedTokens[shapedTokens.length - 1] ?? "";
  return lastShaped === activeLastToken;
}

/** Mirror subtitle FTS hyphen augmentation when filtering cached prefix hits. */
function expandCueTokensForFtsMatch(cueText: string): string[] {
  const tokens = new Set(tokenizeQuote(cueText));
  const hyphenatedWords = cueText.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu) ?? [];
  for (const word of hyphenatedWords) {
    tokens.add(word.replace(/-/g, ""));
  }
  return [...tokens];
}

function tokenizeQuote(quote: string): string[] {
  return quote
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
