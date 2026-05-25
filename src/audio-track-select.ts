import {
  parsePreferredLanguages,
  type SubtitleStreamCandidate,
} from "./subtitles/track-select.ts";

export { parsePreferredLanguages };

export function pickAudioStream(
  streams: SubtitleStreamCandidate[],
  preferredLanguages: string[] = parsePreferredLanguages(),
): SubtitleStreamCandidate | null {
  const audio = streams.filter((stream) => stream.type === "Audio");
  if (audio.length === 0) return null;

  const preferred = new Set(preferredLanguages.map((lang) => lang.toLowerCase()));
  const languageMatches = audio.filter((stream) => {
    const language = stream.language?.toLowerCase();
    return language != null && preferred.has(language);
  });

  const candidates = languageMatches.length > 0 ? languageMatches : audio;
  const sorted = [...candidates].sort((left, right) => scoreAudioStream(right, preferred) - scoreAudioStream(left, preferred));
  return sorted[0] ?? null;
}

function scoreAudioStream(stream: SubtitleStreamCandidate, preferred: Set<string>): number {
  let score = 0;
  if (stream.isDefault) score += 4;
  const language = stream.language?.toLowerCase();
  if (language && preferred.has(language)) score += 8;
  return score;
}
