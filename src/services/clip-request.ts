import { isClipAutocompleteBusyValue } from "../clip-autocomplete.ts";
import { isJellyfinItemId, type MediaKind } from "../jellyfin.ts";
import { parseTimestamp } from "../time.ts";

export type ClipRequestInput = {
  kind: MediaKind;
  itemId: string;
  startRaw?: string | null;
  endRaw?: string | null;
  durationRaw?: string | null;
  maxClipSeconds?: number;
  minClipSeconds?: number;
};

export type ClipPlan = {
  kind: MediaKind;
  itemId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
};

export type ClipRequestResult =
  | { ok: true; plan: ClipPlan }
  | { ok: false; message: string };

const DEFAULT_MAX_CLIP_SECONDS = 180;
const DEFAULT_MIN_CLIP_SECONDS = 1;

export function planClipRequest(input: ClipRequestInput): ClipRequestResult {
  const maxClipSeconds = input.maxClipSeconds ?? DEFAULT_MAX_CLIP_SECONDS;
  const minClipSeconds = input.minClipSeconds ?? DEFAULT_MIN_CLIP_SECONDS;

  if (!input.itemId?.trim()) {
    return { ok: false, message: "`media` is required. Pick a title from autocomplete." };
  }

  if (isClipAutocompleteBusyValue(input.itemId)) {
    return {
      ok: false,
      message: "Media search was busy when you picked that. Click `media` and type again to refresh results.",
    };
  }

  if (!isJellyfinItemId(input.itemId)) {
    return {
      ok: false,
      message: "Pick a title from the autocomplete list. Free-typed text in `media` is not supported.",
    };
  }

  if (!input.startRaw?.trim()) {
    return { ok: false, message: "`start` is required." };
  }

  if (input.endRaw && input.durationRaw) {
    return { ok: false, message: "Use either `end` or `duration`, not both." };
  }

  if (!input.endRaw && !input.durationRaw) {
    return { ok: false, message: "Provide either `end` or `duration`." };
  }

  let startSeconds: number;
  let endSeconds: number;

  try {
    startSeconds = parseTimestamp(input.startRaw);
    endSeconds = input.durationRaw
      ? startSeconds + parseTimestamp(input.durationRaw)
      : parseTimestamp(input.endRaw!);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid timestamp.",
    };
  }

  const durationSeconds = endSeconds - startSeconds;
  if (durationSeconds <= 0) {
    return { ok: false, message: "End time must be after start time." };
  }

  if (durationSeconds < minClipSeconds) {
    return { ok: false, message: `Clip must be at least ${minClipSeconds} second.` };
  }

  if (durationSeconds > maxClipSeconds) {
    return {
      ok: false,
      message: `Clip too long (${Math.round(durationSeconds)}s). Max length is ${maxClipSeconds} seconds.`,
    };
  }

  return {
    ok: true,
    plan: {
      kind: input.kind,
      itemId: input.itemId,
      startSeconds,
      endSeconds,
      durationSeconds,
    },
  };
}

export function expectedItemType(kind: MediaKind): "Movie" | "Episode" {
  return kind === "movie" ? "Movie" : "Episode";
}
