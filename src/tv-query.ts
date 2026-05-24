export type TvMediaQuery = {
  seriesText: string;
  seasonNumber?: number;
  episodeNumber?: number;
};

const SEASON_EPISODE_PATTERN =
  /\b(?:s(?:eason)?\s*)?(\d{1,2})\s*(?:e|x|\*)\s*(\d{1,2})\b|\b(\d{1,2})\s*x\s*(\d{1,2})\b|\bseason\s+(\d{1,2})\s+episode\s+(\d{1,2})\b/i;

const SEASON_ONLY_PATTERN = /\b(?:s(?:eason)?\s*)(\d{1,2})\b(?!\s*(?:e|x|\*)\s*\d)|\bseason\s+(\d{1,2})\b(?!\s+episode\s+\d)/i;

export function parseTvMediaQuery(query: string): TvMediaQuery {
  let remaining = query.trim();

  const seasonEpisodeMatch = remaining.match(SEASON_EPISODE_PATTERN);
  if (seasonEpisodeMatch) {
    const seasonNumber = Number(
      seasonEpisodeMatch[1] ?? seasonEpisodeMatch[3] ?? seasonEpisodeMatch[5],
    );
    const episodeNumber = Number(
      seasonEpisodeMatch[2] ?? seasonEpisodeMatch[4] ?? seasonEpisodeMatch[6],
    );

    remaining = remaining.replace(seasonEpisodeMatch[0], " ").replace(/\s+/g, " ").trim();

    return {
      seriesText: remaining,
      seasonNumber,
      episodeNumber,
    };
  }

  const seasonOnlyMatch = remaining.match(SEASON_ONLY_PATTERN);
  if (seasonOnlyMatch) {
    const seasonNumber = Number(seasonOnlyMatch[1] ?? seasonOnlyMatch[2]);
    remaining = remaining.replace(seasonOnlyMatch[0], " ").replace(/\s+/g, " ").trim();

    return {
      seriesText: remaining,
      seasonNumber,
    };
  }

  return { seriesText: remaining };
}
