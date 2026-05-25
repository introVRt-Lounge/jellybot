import {
  expandLanguageTags,
  languageMatchesPreferred,
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

  const preferred = expandLanguageTags(preferredLanguages);
  const languageMatches = audio.filter((stream) => languageMatchesPreferred(stream.language, preferred));

  const candidates = languageMatches.length > 0 ? languageMatches : audio;
  const sorted = [...candidates].sort((left, right) => scoreAudioStream(right, preferred) - scoreAudioStream(left, preferred));
  return sorted[0] ?? null;
}

function scoreAudioStream(stream: SubtitleStreamCandidate, preferred: Set<string>): number {
  let score = 0;
  if (stream.isDefault) score += 4;
  if (languageMatchesPreferred(stream.language, preferred)) score += 8;
  return score;
}
