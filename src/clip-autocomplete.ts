import type { ApplicationCommandOptionChoiceData } from "discord.js";
import type { MediaKind } from "./jellyfin.ts";
import { searchAutocompleteChoices } from "./autocomplete.ts";
import type { JellyfinClient } from "./jellyfin.ts";

export const CLIP_AUTOCOMPLETE_BUSY_VALUE = "jellybot_autocomplete_busy";

export const CLIP_AUTOCOMPLETE_BUSY_CHOICE: ApplicationCommandOptionChoiceData = {
  name: "Search busy - keep typing to retry",
  value: CLIP_AUTOCOMPLETE_BUSY_VALUE,
};

const DEFAULT_MAX_CONCURRENT = 3;
const CACHE_TTL_MS = 45_000;

type CacheEntry = {
  choices: ApplicationCommandOptionChoiceData[];
  expiresAt: number;
};

class ClipAutocompleteLimiter {
  private active = 0;

  constructor(private maxConcurrent: number) {}

  tryAcquire(): { acquired: true; release: () => void } | { acquired: false } {
    if (this.active >= this.maxConcurrent) {
      return { acquired: false };
    }

    this.active += 1;
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }

  reset(maxConcurrent: number): void {
    this.active = 0;
    this.maxConcurrent = maxConcurrent;
  }

  state(): { active: number; maxConcurrent: number } {
    return { active: this.active, maxConcurrent: this.maxConcurrent };
  }
}

const limiter = new ClipAutocompleteLimiter(
  Number(process.env.CLIP_AUTOCOMPLETE_MAX_CONCURRENT ?? DEFAULT_MAX_CONCURRENT),
);
const cache = new Map<string, CacheEntry>();

function cacheKey(kind: MediaKind, query: string): string {
  return `${kind}:${query.trim().toLowerCase()}`;
}

export function getCachedClipMediaChoices(
  kind: MediaKind,
  query: string,
): ApplicationCommandOptionChoiceData[] | null {
  const key = cacheKey(kind, query);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.choices;
}

export function setCachedClipMediaChoices(
  kind: MediaKind,
  query: string,
  choices: ApplicationCommandOptionChoiceData[],
): void {
  cache.set(cacheKey(kind, query), {
    choices,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function isClipAutocompleteBusyValue(value: string): boolean {
  return value.trim() === CLIP_AUTOCOMPLETE_BUSY_VALUE;
}

export async function searchClipMediaAutocompleteChoices(
  jellyfin: JellyfinClient,
  query: string,
  kind: MediaKind,
  signal?: AbortSignal,
): Promise<ApplicationCommandOptionChoiceData[]> {
  const cached = getCachedClipMediaChoices(kind, query);
  if (cached) {
    return cached;
  }

  const slot = limiter.tryAcquire();
  if (!slot.acquired) {
    return [CLIP_AUTOCOMPLETE_BUSY_CHOICE];
  }

  try {
    const cachedAfterWait = getCachedClipMediaChoices(kind, query);
    if (cachedAfterWait) {
      return cachedAfterWait;
    }

    const choices = await searchAutocompleteChoices(jellyfin, query, kind, signal);
    setCachedClipMediaChoices(kind, query, choices);
    return choices;
  } finally {
    slot.release();
  }
}

/** Test helper */
export function resetClipAutocompleteState(maxConcurrent = DEFAULT_MAX_CONCURRENT): void {
  limiter.reset(maxConcurrent);
  cache.clear();
}

export function clipAutocompleteLimiterState(): { active: number; maxConcurrent: number } {
  return limiter.state();
}
