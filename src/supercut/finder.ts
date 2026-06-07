import type { QuoteSearchResult, SubtitleIndex } from "../subtitles/index-db.ts";

export type SupercutCue = {
  itemId: string;
  itemType: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  productionYear?: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type FindSupercutCuesOptions = {
  query: string;
  seriesName?: string;
  titleEquals?: string;
  /** Hard ceiling on raw FTS rows fetched (before coalesce + cap). */
  searchLimit: number;
};

export function findSupercutCues(
  index: SubtitleIndex,
  opts: FindSupercutCuesOptions,
): SupercutCue[] {
  const rows = index.searchSupercutCues({
    query: opts.query,
    seriesName: opts.seriesName,
    titleEquals: opts.titleEquals,
    limit: opts.searchLimit,
  });
  return rows.map(toSupercutCue);
}

function toSupercutCue(row: QuoteSearchResult): SupercutCue {
  return {
    itemId: row.itemId,
    itemType: row.itemType,
    title: row.title,
    seriesName: row.seriesName ?? undefined,
    seasonNumber: row.seasonNumber ?? undefined,
    episodeNumber: row.episodeNumber ?? undefined,
    productionYear: row.productionYear ?? undefined,
    startMs: row.startMs,
    endMs: row.endMs,
    text: row.text,
  };
}

/**
 * Merge cues from the same media item that sit within `gapMs` of each other
 * into a single span. Avoids generating sub-second flicker clips when the
 * same line spans two adjacent SRT cues, and produces a more natural-feeling
 * supercut. Cues from different items are never merged (different files).
 *
 * Input must already be sorted by item then start time; the FTS query in
 * SubtitleIndex.searchSupercutCues guarantees this.
 */
export function coalesceCues(cues: SupercutCue[], gapMs: number): SupercutCue[] {
  if (cues.length === 0) return [];
  const out: SupercutCue[] = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.itemId === cue.itemId &&
      cue.startMs - prev.endMs <= gapMs &&
      cue.startMs >= prev.startMs
    ) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      prev.text = `${prev.text} | ${cue.text}`;
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

export type SupercutPlan = {
  cues: SupercutCue[];
  /** Estimated total runtime in seconds, including padding on each cue. */
  estimatedDurationSeconds: number;
  /** Cues that were dropped because they would push past the runtime cap. */
  trimmedForRuntime: number;
};

export type PlanSupercutOptions = {
  cues: SupercutCue[];
  paddingMs: number;
  maxClips: number;
  maxDurationSeconds: number;
};

/**
 * Apply hard caps to a coalesced cue list. `maxClips` trims by count first,
 * then `maxDurationSeconds` walks the remaining cues and stops once adding
 * another would push the running total past the cap. Order is preserved.
 */
export function planSupercut(opts: PlanSupercutOptions): SupercutPlan {
  const padded = (cue: SupercutCue): number => (cue.endMs - cue.startMs + opts.paddingMs * 2) / 1000;

  const capped = opts.cues.slice(0, opts.maxClips);
  const accepted: SupercutCue[] = [];
  let total = 0;
  for (const cue of capped) {
    const dur = padded(cue);
    if (total + dur > opts.maxDurationSeconds && accepted.length > 0) break;
    accepted.push(cue);
    total += dur;
  }

  return {
    cues: accepted,
    estimatedDurationSeconds: total,
    trimmedForRuntime: opts.cues.length - accepted.length,
  };
}
