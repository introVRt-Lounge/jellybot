import type { QuoteSearchResult, SubtitleIndex } from "../subtitles/index-db.ts";

export type QuoteRequestMatch = {
  candidate: QuoteSearchResult;
  titleScore: number;     // 0..1
  cueRank: number;        // FTS bm25 score (lower = stronger)
  confidence: "high" | "medium" | "none";
};

const DEFAULT_TITLE_THRESHOLD = 0.55;
const STRONG_TITLE_THRESHOLD = 0.8;

export function findQuoteRequestMatch(
  index: Pick<SubtitleIndex, "searchQuotes">,
  movieText: string,
  quoteText: string,
  options: { searchLimit?: number; titleThreshold?: number } = {},
): QuoteRequestMatch | null {
  const searchLimit = options.searchLimit ?? 25;
  const titleThreshold = options.titleThreshold ?? DEFAULT_TITLE_THRESHOLD;

  const cleanedMovie = normaliseTitle(movieText);
  if (!cleanedMovie) return null;

  const cleanedQuote = quoteText.trim();
  if (!cleanedQuote) return null;

  const candidates = index.searchQuotes(cleanedQuote, searchLimit);
  if (candidates.length === 0) return null;

  let best: QuoteRequestMatch | null = null;

  for (const candidate of candidates) {
    const titleScore = scoreTitleMatch(cleanedMovie, candidate);
    if (titleScore < titleThreshold) continue;

    const confidence: QuoteRequestMatch["confidence"] =
      titleScore >= STRONG_TITLE_THRESHOLD ? "high" : "medium";

    if (!best || isBetter(titleScore, candidate.rank, best)) {
      best = { candidate, titleScore, cueRank: candidate.rank, confidence };
    }
  }

  return best;
}

function isBetter(
  newTitleScore: number,
  newRank: number,
  current: QuoteRequestMatch,
): boolean {
  // Higher title score wins; tiebreak by tighter (lower) FTS rank.
  if (newTitleScore !== current.titleScore) {
    return newTitleScore > current.titleScore;
  }
  return newRank < current.cueRank;
}

function scoreTitleMatch(cleanedMovie: string, candidate: QuoteSearchResult): number {
  const candidateTitles: string[] = [];

  if (candidate.itemType === "Episode" && candidate.seriesName) {
    candidateTitles.push(candidate.seriesName);
  }
  candidateTitles.push(candidate.title);

  let best = 0;
  for (const raw of candidateTitles) {
    const cleaned = normaliseTitle(raw);
    if (!cleaned) continue;
    const score = compareTitles(cleanedMovie, cleaned);
    if (score > best) {
      best = score;
    }
  }

  return best;
}

function compareTitles(a: string, b: string): number {
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    return shorter.length / longer.length;
  }

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersect = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersect += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersect / union;
}

export function normaliseTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\s'&]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
