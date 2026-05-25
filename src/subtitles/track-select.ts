export type SubtitleStreamCandidate = {
  type: string;
  index: number;
  codec?: string;
  language?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isTextSubtitleStream?: boolean;
};

const DEFAULT_LANGUAGES = ["eng", "en", "english"];

const LANGUAGE_ALIASES: Record<string, readonly string[]> = {
  eng: ["eng", "en", "english"],
  en: ["eng", "en", "english"],
  english: ["eng", "en", "english"],
};

export function parsePreferredLanguages(raw?: string): string[] {
  if (!raw?.trim()) return DEFAULT_LANGUAGES;
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function expandLanguageTags(languages: string[]): Set<string> {
  const expanded = new Set<string>();

  for (const language of languages) {
    const lower = language.toLowerCase();
    expanded.add(lower);

    for (const alias of LANGUAGE_ALIASES[lower] ?? []) {
      expanded.add(alias);
    }

    const base = lower.split("-")[0];
    if (base) {
      expanded.add(base);
      for (const alias of LANGUAGE_ALIASES[base] ?? []) {
        expanded.add(alias);
      }
    }
  }

  return expanded;
}

export function languageMatchesPreferred(tag: string | undefined, preferred: Set<string>): boolean {
  if (!tag) return false;

  const lower = tag.toLowerCase();
  if (preferred.has(lower)) return true;

  const base = lower.split("-")[0];
  return base != null && preferred.has(base);
}

export function pickSubtitleStream(
  streams: SubtitleStreamCandidate[],
  preferredLanguages: string[] = DEFAULT_LANGUAGES,
): SubtitleStreamCandidate | null {
  const subtitles = streams.filter(
    (stream) => stream.type === "Subtitle" && stream.isTextSubtitleStream !== false,
  );
  if (subtitles.length === 0) return null;

  const preferred = expandLanguageTags(preferredLanguages);
  const nonForced = subtitles.filter((stream) => !stream.isForced);
  const pool = nonForced.length > 0 ? nonForced : subtitles;

  const languageMatches = pool.filter((stream) => languageMatchesPreferred(stream.language, preferred));

  const candidates = languageMatches.length > 0 ? languageMatches : pool;
  const sorted = [...candidates].sort((left, right) => scoreStream(right, preferred) - scoreStream(left, preferred));
  return sorted[0] ?? null;
}

function scoreStream(stream: SubtitleStreamCandidate, preferred: Set<string>): number {
  let score = 0;
  if (stream.isDefault) score += 4;
  if (languageMatchesPreferred(stream.language, preferred)) score += 8;
  if (stream.codec?.toLowerCase() === "subrip") score += 1;
  if (stream.isForced) score -= 2;
  return score;
}
