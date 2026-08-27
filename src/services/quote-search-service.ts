import { shapeQuoteAutocompleteQuery } from "../subtitles/quote-query-shaping.ts";
import type { QuoteSearchResult } from "../subtitles/index-db.ts";
import { encodeQuoteMatchToken } from "../subtitles/match-token.ts";
import { buildQuoteChoiceLabel } from "../subtitles/quote-suggestion-label.ts";
import { getSubtitleSearchIndex } from "../subtitles/search-index.ts";

export type QuoteSuggestion = {
  token: string;
  label: string;
  itemId: string;
  startMs: number;
  endMs: number;
  text: string;
  title: string;
  seriesName?: string;
};

export type QuoteSearchOptions = {
  seriesFilter?: string;
  limit?: number;
  minQueryLength?: number;
};

const DEFAULT_LIMIT = 25;

export function minQuoteQueryLength(seriesFilter?: string): number {
  return seriesFilter ? 1 : 3;
}

export function buildQuoteSuggestions(results: QuoteSearchResult[]): QuoteSuggestion[] {
  const seen = new Set<string>();
  const suggestions: QuoteSuggestion[] = [];

  for (const result of results) {
    const token = encodeQuoteMatchToken({
      itemId: result.itemId,
      startMs: result.startMs,
      endMs: result.endMs,
    }).slice(0, 100);

    if (seen.has(token)) continue;
    seen.add(token);

    suggestions.push({
      token,
      label: buildQuoteChoiceLabel(result),
      itemId: result.itemId,
      startMs: result.startMs,
      endMs: result.endMs,
      text: result.text,
      title: result.title,
      seriesName: result.seriesName,
    });

    if (suggestions.length >= DEFAULT_LIMIT) break;
  }

  return suggestions;
}

export function searchQuoteSuggestions(
  subtitleDbPath: string,
  query: string,
  options: QuoteSearchOptions = {},
): QuoteSuggestion[] {
  const trimmed = query.trim();
  const seriesFilter =
    options.seriesFilter && options.seriesFilter.trim().length > 0
      ? options.seriesFilter.trim()
      : undefined;
  const minLength = options.minQueryLength ?? minQuoteQueryLength(seriesFilter);

  if (trimmed.length < minLength) {
    return [];
  }

  const searchQuery = shapeQuoteAutocompleteQuery(trimmed);
  const index = getSubtitleSearchIndex(subtitleDbPath);
  const limit = Math.min(options.limit ?? 24, DEFAULT_LIMIT);
  const results = index.searchQuotes(searchQuery, limit, seriesFilter);
  return buildQuoteSuggestions(results);
}

export function searchQuoteSeriesNames(
  subtitleDbPath: string,
  prefix: string,
  limit = 25,
): string[] {
  const index = getSubtitleSearchIndex(subtitleDbPath);
  return index.listSeriesNames(prefix.trim(), limit);
}
