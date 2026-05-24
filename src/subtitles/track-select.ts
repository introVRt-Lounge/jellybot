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

export function parsePreferredLanguages(raw?: string): string[] {
  if (!raw?.trim()) return DEFAULT_LANGUAGES;
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function pickSubtitleStream(
  streams: SubtitleStreamCandidate[],
  preferredLanguages: string[] = DEFAULT_LANGUAGES,
): SubtitleStreamCandidate | null {
  const subtitles = streams.filter(
    (stream) => stream.type === "Subtitle" && stream.isTextSubtitleStream !== false,
  );
  if (subtitles.length === 0) return null;

  const preferred = new Set(preferredLanguages.map((lang) => lang.toLowerCase()));
  const nonForced = subtitles.filter((stream) => !stream.isForced);
  const pool = nonForced.length > 0 ? nonForced : subtitles;

  const languageMatches = pool.filter((stream) => {
    const language = stream.language?.toLowerCase();
    return language != null && preferred.has(language);
  });

  const candidates = languageMatches.length > 0 ? languageMatches : pool;
  const sorted = [...candidates].sort((left, right) => scoreStream(right, preferred) - scoreStream(left, preferred));
  return sorted[0] ?? null;
}

function scoreStream(stream: SubtitleStreamCandidate, preferred: Set<string>): number {
  let score = 0;
  if (stream.isDefault) score += 4;
  const language = stream.language?.toLowerCase();
  if (language && preferred.has(language)) score += 8;
  if (stream.codec?.toLowerCase() === "subrip") score += 1;
  if (stream.isForced) score -= 2;
  return score;
}
