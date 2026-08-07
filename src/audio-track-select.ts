import {
  expandLanguageTags,
  languageMatchesPreferred,
  parsePreferredLanguages,
  type SubtitleStreamCandidate,
} from "./subtitles/track-select.ts";

export { parsePreferredLanguages };

/** Match director / cast commentary and similar non-theatrical mixes (#184). */
const COMMENTARY_TITLE_RE =
  /\b(commentary|commentaries|director'?s?\s+comment|with\s+commentary|audio\s+commentary)\b/i;

export function isCommentaryAudioTrack(stream: Pick<SubtitleStreamCandidate, "title" | "displayTitle">): boolean {
  const haystack = `${stream.title ?? ""} ${stream.displayTitle ?? ""}`.trim();
  if (!haystack) return false;
  return COMMENTARY_TITLE_RE.test(haystack);
}

/**
 * 0-based position of `pickedIndex` among Audio streams ordered by Jellyfin
 * MediaStream.Index. Used for ffmpeg `-map 0:a:N` because Jellyfin's absolute
 * Index is often NOT the container stream index (#184).
 */
export function audioStreamOrdinal(
  streams: SubtitleStreamCandidate[],
  pickedIndex: number,
): number | null {
  const audios = streams
    .filter((stream) => stream.type === "Audio")
    .sort((left, right) => left.index - right.index);
  const ordinal = audios.findIndex((stream) => stream.index === pickedIndex);
  return ordinal >= 0 ? ordinal : null;
}

export function pickAudioStream(
  streams: SubtitleStreamCandidate[],
  preferredLanguages: string[] = parsePreferredLanguages(),
): SubtitleStreamCandidate | null {
  const audio = streams.filter((stream) => stream.type === "Audio");
  if (audio.length === 0) return null;

  const preferred = expandLanguageTags(preferredLanguages);
  const nonCommentary = audio.filter((stream) => !isCommentaryAudioTrack(stream));
  // Prefer any theatrical mix over commentary, even if commentary is the
  // only preferred-language match (#184 Jerry Maguire).
  const pool = nonCommentary.length > 0 ? nonCommentary : audio;

  const languageMatches = pool.filter((stream) => languageMatchesPreferred(stream.language, preferred));
  const candidates = languageMatches.length > 0 ? languageMatches : pool;
  const sorted = [...candidates].sort(
    (left, right) => scoreAudioStream(right, preferred) - scoreAudioStream(left, preferred),
  );
  return sorted[0] ?? null;
}

function scoreAudioStream(stream: SubtitleStreamCandidate, preferred: Set<string>): number {
  let score = 0;
  if (isCommentaryAudioTrack(stream)) score -= 100;
  if (stream.isDefault) score += 4;
  if (languageMatchesPreferred(stream.language, preferred)) score += 8;
  // Prefer richer theatrical mixes when titles/defaults tie.
  if (typeof stream.channels === "number" && stream.channels > 0) {
    score += Math.min(stream.channels, 8);
  }
  return score;
}
