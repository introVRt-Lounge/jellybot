import type { MediaKind } from "../jellyfin.ts";
import { parseTimestamp } from "../time.ts";
import type { QuoteSearchResult } from "../subtitles/index-db.ts";

export type QuoteClipInput = {
  match: QuoteSearchResult;
  durationRaw?: string | null;
  paddingRaw?: string | null;
  maxClipSeconds: number;
  defaultClipSeconds: number;
  defaultPaddingSeconds: number;
};

export type QuoteClipPlan = {
  kind: MediaKind;
  itemId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  quoteText: string;
  cueStartSeconds: number;
  cueEndSeconds: number;
};

export type QuoteClipResult =
  | { ok: true; plan: QuoteClipPlan }
  | { ok: false; message: string };

export function mediaKindForItemType(itemType: string): MediaKind | null {
  if (itemType === "Movie") return "movie";
  if (itemType === "Episode") return "tv";
  return null;
}

export function planQuoteClip(input: QuoteClipInput): QuoteClipResult {
  const kind = mediaKindForItemType(input.match.itemType);
  if (!kind) {
    return { ok: false, message: "That indexed item is not a movie or TV episode." };
  }

  let paddingSeconds = input.defaultPaddingSeconds;
  let durationSeconds = input.defaultClipSeconds;

  try {
    if (input.paddingRaw?.trim()) {
      paddingSeconds = parseTimestamp(input.paddingRaw);
    }
    if (input.durationRaw?.trim()) {
      durationSeconds = parseTimestamp(input.durationRaw);
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid timestamp.",
    };
  }

  if (durationSeconds <= 0) {
    return { ok: false, message: "Clip duration must be greater than zero." };
  }

  if (durationSeconds > input.maxClipSeconds) {
    return {
      ok: false,
      message: `Clip too long (${Math.round(durationSeconds)}s). Max length is ${input.maxClipSeconds} seconds.`,
    };
  }

  const cueStartSeconds = input.match.startMs / 1000;
  const cueEndSeconds = input.match.endMs / 1000;
  let startSeconds = Math.max(0, cueStartSeconds - paddingSeconds);

  if (input.match.runtimeTicks) {
    const runtimeSeconds = input.match.runtimeTicks / 10_000_000;
    if (startSeconds >= runtimeSeconds) {
      return { ok: false, message: "Quote timestamp is beyond the runtime of that item." };
    }

    if (startSeconds + durationSeconds > runtimeSeconds) {
      durationSeconds = Math.max(1, runtimeSeconds - startSeconds);
    }
  }

  const endSeconds = startSeconds + durationSeconds;
  if (endSeconds <= startSeconds) {
    return { ok: false, message: "Could not build a clip window for that quote." };
  }

  return {
    ok: true,
    plan: {
      kind,
      itemId: input.match.itemId,
      startSeconds,
      endSeconds,
      durationSeconds,
      quoteText: input.match.text,
      cueStartSeconds,
      cueEndSeconds,
    },
  };
}
