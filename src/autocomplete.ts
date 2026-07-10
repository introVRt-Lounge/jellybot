import type { ApplicationCommandOptionChoiceData } from "discord.js";
import type { JellyfinClient, JellyfinItem, MediaKind } from "./jellyfin.ts";
import { formatEpisodeLabel } from "./jellyfin.ts";
import { displayTitleWithYear } from "./display-title.ts";

const MAX_CHOICE_NAME = 100;
const MAX_CHOICE_VALUE = 100;
const MAX_CHOICES = 25;

export function compactItemLabel(item: JellyfinItem, kind: MediaKind): string {
  if (kind === "tv" && item.seriesName) {
    const episode = formatEpisodeLabel(item);
    const compactEpisode = episode.length > 48 ? `${episode.slice(0, 45)}...` : episode;
    const show = item.seriesName.length > 42 ? `${item.seriesName.slice(0, 39)}...` : item.seriesName;
    return `${show} - ${compactEpisode}`;
  }

  return displayTitleWithYear(item);
}

export function toAutocompleteChoices(
  items: JellyfinItem[],
  kind: MediaKind,
  formatLabel: (item: JellyfinItem, kind?: MediaKind) => string,
): ApplicationCommandOptionChoiceData[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const choices: ApplicationCommandOptionChoiceData[] = [];

  for (const item of items) {
    if (seenIds.has(item.id)) continue;

    const value = item.id.slice(0, MAX_CHOICE_VALUE);
    if (!value) continue;

    const rawName = compactItemLabel(item, kind) || formatLabel(item, kind);
    const name = uniqueChoiceName(truncate(rawName, MAX_CHOICE_NAME), seenNames);
    if (!name) continue;

    seenIds.add(item.id);
    seenNames.add(name);
    choices.push({ name, value });

    if (choices.length >= MAX_CHOICES) break;
  }

  return choices;
}

export function uniqueChoiceName(name: string, seenNames: Set<string>): string {
  if (!seenNames.has(name)) {
    return name;
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const tail = ` (${suffix})`;
    const candidate = truncate(name, MAX_CHOICE_NAME - tail.length) + tail;
    if (!seenNames.has(candidate)) {
      return candidate;
    }
  }

  return name;
}

/** Lets other interaction handlers (e.g. `/quote series:`) run between keystrokes. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Discord autocomplete interactions expire ~3s after receipt; leave headroom for FTS. */
export const DISCORD_AUTOCOMPLETE_RESPONSE_DEADLINE_MS = 2500;

/**
 * Per-keystroke pause before `/quote match` FTS. Keep ≤100ms — gateway RTT + search must
 * still fit Discord's ~3s hard limit (#173).
 */
export const QUOTE_MATCH_AUTOCOMPLETE_DEBOUNCE_MS = 100;

export function autocompleteInteractionAgeMs(interaction: { createdTimestamp: number }): number {
  return Date.now() - interaction.createdTimestamp;
}

export function remainingAutocompleteBudgetMs(
  interaction: { createdTimestamp: number },
  maxAgeMs: number,
  floorMs = 50,
): number {
  return Math.max(floorMs, maxAgeMs - autocompleteInteractionAgeMs(interaction));
}

export function isAutocompleteInteractionExpired(
  interaction: { createdTimestamp: number },
  maxAgeMs = DISCORD_AUTOCOMPLETE_RESPONSE_DEADLINE_MS,
): boolean {
  return autocompleteInteractionAgeMs(interaction) > maxAgeMs;
}

/**
 * Waits `debounceMs` unless `signal` aborts first (new keystroke superseded this token).
 * Pair with AutocompleteSessionGuard.beginCancellable so overlapping tokens cancel the wait.
 */
export function waitDebounced(debounceMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      resolve();
    }, debounceMs);

    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run synchronous work on a later turn so callers can interleave and
 * `withTimeout` can fire while earlier handlers yield. The work function
 * must not run at argument-evaluation time (see issue #147 / quote autocomplete).
 */
export async function runDeferredSyncWithTimeout<T>(
  work: () => T,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  return withTimeout(
    new Promise<T>((resolve, reject) => {
      setImmediate(() => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        try {
          resolve(work());
        } catch (error) {
          reject(error);
        }
      });
    }),
    ms,
    signal,
  );
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Autocomplete timed out")), ms);
  });

  const abort = new Promise<never>((_, reject) => {
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([promise, timeout, ...(signal ? [abort] : [])]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function searchAutocompleteChoices(
  jellyfin: JellyfinClient,
  query: string,
  kind: MediaKind,
  signal?: AbortSignal,
): Promise<ApplicationCommandOptionChoiceData[]> {
  const results = await withTimeout(jellyfin.search(query, kind, MAX_CHOICES, { signal }), 2500, signal);
  return toAutocompleteChoices(results, kind, jellyfin.formatItemLabel.bind(jellyfin));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
