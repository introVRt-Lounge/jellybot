import type { MediaKind } from "../jellyfin.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import {
  CLIP_AUTOCOMPLETE_BUSY_VALUE,
  getCachedClipMediaChoices,
  searchClipMediaAutocompleteChoices,
} from "../clip-autocomplete.ts";

export type MediaSuggestion = {
  itemId: string;
  label: string;
  kind: MediaKind;
  busy?: boolean;
};

export const CLIP_KIND_OPTIONS: { kind: MediaKind; label: string }[] = [
  { kind: "movie", label: "Movie" },
  { kind: "tv", label: "TV episode" },
];

export function filterClipKinds(query: string): typeof CLIP_KIND_OPTIONS {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return CLIP_KIND_OPTIONS;
  return CLIP_KIND_OPTIONS.filter(
    (entry) =>
      entry.label.toLowerCase().includes(normalized) || entry.kind.includes(normalized),
  );
}

export async function searchMediaSuggestions(
  jellyfin: JellyfinClient,
  kind: MediaKind,
  query: string,
  signal?: AbortSignal,
): Promise<MediaSuggestion[]> {
  const cached = getCachedClipMediaChoices(kind, query);
  if (cached) {
    return cached.map((choice) => ({
      itemId: String(choice.value),
      label: choice.name,
      kind,
      busy: choice.value === CLIP_AUTOCOMPLETE_BUSY_VALUE,
    }));
  }

  const choices = await searchClipMediaAutocompleteChoices(jellyfin, query, kind, signal);
  return choices.map((choice) => ({
    itemId: String(choice.value),
    label: choice.name,
    kind,
    busy: choice.value === CLIP_AUTOCOMPLETE_BUSY_VALUE,
  }));
}
