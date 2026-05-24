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

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Autocomplete timed out")), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function searchAutocompleteChoices(
  jellyfin: JellyfinClient,
  query: string,
  kind: MediaKind,
): Promise<ApplicationCommandOptionChoiceData[]> {
  const results = await withTimeout(jellyfin.search(query, kind, MAX_CHOICES), 2500);
  return toAutocompleteChoices(results, kind, jellyfin.formatItemLabel.bind(jellyfin));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
