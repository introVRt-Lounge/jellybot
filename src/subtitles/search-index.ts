import { openSubtitleIndex, type SubtitleIndex } from "./index-db.ts";

let cachedSearchIndex: { dbPath: string; index: SubtitleIndex } | null = null;

export function getSubtitleSearchIndex(dbPath: string): SubtitleIndex {
  if (cachedSearchIndex?.dbPath === dbPath) {
    return cachedSearchIndex.index;
  }

  cachedSearchIndex?.index.close();
  const index = openSubtitleIndex(dbPath, { readonly: true });
  cachedSearchIndex = { dbPath, index };
  return index;
}

export function resetSubtitleSearchIndexForTests(): void {
  cachedSearchIndex?.index.close();
  cachedSearchIndex = null;
}
