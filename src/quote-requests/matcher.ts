import type { QuoteSearchResult, SubtitleIndex } from "../subtitles/index-db.ts";

export type QuoteRequestMatch = {
  candidate: QuoteSearchResult;
  titleScore: number;     // 0..1
  cueRank: number;        // FTS bm25 score (lower = stronger)
  confidence: "high" | "medium" | "none";
};

const DEFAULT_TITLE_THRESHOLD = 0.55;
const STRONG_TITLE_THRESHOLD = 0.8;
const RELAXED_MIN_DISTINCTIVE_TOKENS = 2;
const DISTINCTIVE_TOKEN_MIN_LENGTH = 4;
// Anchor-fallback tier (#137): the first N distinctive tokens of a long
// quote are AND'd to find the cue where the dialogue starts. The clip
// renders from that cue's timestamp, so users can submit verbose monologue
// quotes that span 3+ SRT cues without us doubling index size with wider
// merged windows.
const ANCHOR_TOKEN_COUNT = 4;
// #136: when the user's movie text is a strict subset of the candidate
// title (token-level), treat the title score as strong enough to clear
// the default threshold even if the character-ratio is low ("Buffy" ->
// "Buffy the Vampire Slayer" sits at 0.25 by raw char ratio but is
// obviously the right show).
const SUBSTRING_CONTAINMENT_FLOOR = 0.6;

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

  let candidates = index.searchQuotes(cleanedQuote, searchLimit);
  let usedRelaxedSearch = false;
  let usedAnchorSearch = false;

  // Real users misremember small filler words ("watch me soar" vs "watch how I
  // soar"), and the FTS query AND-joins every >=2-char token. If the strict
  // search came up empty, retry using only distinctive (>=4-char) tokens so
  // forgotten connectives don't kill the match. The distinctive set still has
  // to be specific enough on its own (>=2 long tokens) or we skip the retry.
  const distinctive = extractDistinctiveTokens(cleanedQuote);
  if (candidates.length === 0) {
    if (distinctive.length >= RELAXED_MIN_DISTINCTIVE_TOKENS) {
      candidates = index.searchQuotes(distinctive.join(" "), searchLimit);
      usedRelaxedSearch = candidates.length > 0;
    }
  }

  // #137: anchor fallback for long monologues that span 3+ cues. Both
  // strict and relaxed FTS need every token in a single FTS row, so a
  // 5-cue monologue can't match even with #130's merged-window indexing.
  // Retry with just the first N distinctive tokens to anchor the match
  // on where the dialogue starts; the clip renders from that cue's time.
  // Confidence is forced to medium downstream so anchor hits never look
  // as authoritative as a full-quote match.
  if (candidates.length === 0 && distinctive.length > ANCHOR_TOKEN_COUNT) {
    const anchor = distinctive.slice(0, ANCHOR_TOKEN_COUNT);
    candidates = index.searchQuotes(anchor.join(" "), searchLimit);
    usedAnchorSearch = candidates.length > 0;
  }

  if (candidates.length === 0) return null;

  let best: QuoteRequestMatch | null = null;

  for (const candidate of candidates) {
    const titleScore = scoreTitleMatch(cleanedMovie, candidate);
    if (titleScore < titleThreshold) continue;

    let confidence: QuoteRequestMatch["confidence"] =
      titleScore >= STRONG_TITLE_THRESHOLD ? "high" : "medium";

    // Relaxed-fallback hits are inherently fuzzier; never auto-promote past
    // medium even when the title is a perfect match. Same rule for anchor
    // hits (#137): we only matched the START of the quote, not the whole
    // span, so the user-visible confidence shouldn't claim more than that.
    if ((usedRelaxedSearch || usedAnchorSearch) && confidence === "high") {
      confidence = "medium";
    }

    if (!best || isBetter(titleScore, candidate.rank, best)) {
      best = { candidate, titleScore, cueRank: candidate.rank, confidence };
    }
  }

  return best;
}

function extractDistinctiveTokens(quote: string): string[] {
  return quote
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= DISTINCTIVE_TOKEN_MIN_LENGTH);
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

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  // Token-level full containment ("buffy" -> "buffy vampire slayer") gets a
  // confidence floor so short user input vs long series names doesn't get
  // killed by the raw character ratio (#136). Still bounded by token-jaccard
  // upward — a single common word like "the" can't trip the floor because we
  // require at least one >=4-char distinctive token in `a`.
  const aIsSubsetOfB = [...aTokens].every((t) => bTokens.has(t));
  const bIsSubsetOfA = [...bTokens].every((t) => aTokens.has(t));
  const hasDistinctiveAnchor = [...aTokens].some(
    (t) => t.length >= DISTINCTIVE_TOKEN_MIN_LENGTH,
  );

  if ((aIsSubsetOfB || bIsSubsetOfA) && hasDistinctiveAnchor) {
    // Pure character ratio falls out of token containment as a tie-breaker
    // upper bound: "buffy"(5) vs "buffy vampire slayer"(20) -> ratio 0.25,
    // but the floor lifts it to 0.6 (matchable, not strong). "lebowski"(8)
    // vs "big lebowski"(12) -> ratio 0.67, ratio wins.
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    const charRatio = shorter.length / longer.length;
    return Math.max(charRatio, SUBSTRING_CONTAINMENT_FLOOR);
  }

  // Plain string-includes (no token boundary) is only used when token
  // containment didn't fire — it's a weaker signal so it doesn't get the
  // floor treatment, just the raw character ratio.
  if (b.includes(a) || a.includes(b)) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    return shorter.length / longer.length;
  }

  let intersect = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersect += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersect / union;
}

const QUALITY_TOKENS = new Set([
  "4k",
  "8k",
  "uhd",
  "hd",
  "720p",
  "1080p",
  "1440p",
  "2160p",
  "4320p",
  "720",
  "1080",
  "2160",
  "hdr",
  "hdr10",
  "hdr10plus",
  "dv",
  "dolby",
  "vision",
  "atmos",
  "hevc",
  "x265",
  "x264",
  "h265",
  "h264",
  "av1",
  "bluray",
  "brrip",
  "bdrip",
  "web",
  "webrip",
  "webdl",
  "remux",
  "remastered",
  "directors",
  "director's",
  "extended",
  "imax",
  "10bit",
]);

export function normaliseTitle(value: string): string {
  // Strip parenthesised/bracketed year tags first so titles like "Serenity (2005) 4K"
  // or "Inception [2010]" lose the year component before we tokenise. Bare leading
  // four-digit titles (e.g. "1917") are preserved because they don't sit inside
  // brackets in any sensible library naming scheme.
  const yearTagsRemoved = value.replace(/[(\[]\s*(?:19|20)\d{2}\s*[)\]]/g, " ");

  const stripped = yearTagsRemoved
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\s'&]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!stripped) return stripped;

  const filtered = stripped
    .split(" ")
    .filter((token) => token.length > 0 && !QUALITY_TOKENS.has(token))
    .join(" ");

  // If filtering would obliterate the title (e.g. just "4K"), keep the original
  // normalised form so the matcher still has something to compare against.
  return filtered.length > 0 ? filtered : stripped;
}
