import type { JellyfinClient, JellyfinItem } from "../jellyfin.ts";
import { displayTitleWithYear } from "../display-title.ts";
import type { SubtitleIndexStats } from "../subtitles/index-db.ts";

export type CoverageSlice = {
  withSubtitles: number;
  total: number;
};

export type LibrarySubtitleCoverage = {
  kind: "library";
  movies: CoverageSlice;
  episodes: CoverageSlice;
  /** Jellyfin items with HasSubtitles (all libraries) - matches the subtitle indexer scope. */
  jellyfinSubtitledTotal: number;
  quoteIndex: SubtitleIndexStats | null;
};

export type SeriesSubtitleCoverage = {
  kind: "series";
  title: string;
  episodes: CoverageSlice;
};

export type MovieSubtitleCoverage = {
  kind: "movie";
  title: string;
  hasSubtitles: boolean;
};

export type SubtitleCoverageReport =
  | LibrarySubtitleCoverage
  | SeriesSubtitleCoverage
  | MovieSubtitleCoverage;

export function coveragePercent(slice: CoverageSlice): number | null {
  if (slice.total === 0) return null;
  return (slice.withSubtitles / slice.total) * 100;
}

export function formatCoveragePercent(slice: CoverageSlice): string {
  const percent = coveragePercent(slice);
  if (percent == null) return "n/a";
  return `${percent.toFixed(1)}%`;
}

export function formatCoverageLine(label: string, slice: CoverageSlice): string {
  const percent = formatCoveragePercent(slice);
  return `**${label}:** ${slice.withSubtitles.toLocaleString()} / ${slice.total.toLocaleString()} (${percent})`;
}

export function combineCoverageSlices(slices: CoverageSlice[]): CoverageSlice {
  return slices.reduce(
    (acc, slice) => ({
      withSubtitles: acc.withSubtitles + slice.withSubtitles,
      total: acc.total + slice.total,
    }),
    { withSubtitles: 0, total: 0 },
  );
}

export async function buildLibrarySubtitleCoverage(
  jellyfin: JellyfinClient,
  quoteIndex: SubtitleIndexStats | null,
): Promise<LibrarySubtitleCoverage> {
  const [movieTotal, movieSubtitled, episodeTotal, episodeSubtitled, jellyfinSubtitledTotal] =
    await Promise.all([
      jellyfin.countLibraryMovies(),
      jellyfin.countLibraryMovies({ hasSubtitles: true }),
      jellyfin.countLibraryEpisodes(),
      jellyfin.countLibraryEpisodes({ hasSubtitles: true }),
      jellyfin.countSubtitledMedia(),
    ]);

  return {
    kind: "library",
    movies: { total: movieTotal, withSubtitles: movieSubtitled },
    episodes: { total: episodeTotal, withSubtitles: episodeSubtitled },
    jellyfinSubtitledTotal,
    quoteIndex,
  };
}

export async function buildSeriesSubtitleCoverage(
  jellyfin: JellyfinClient,
  series: JellyfinItem,
): Promise<SeriesSubtitleCoverage> {
  const [total, withSubtitles] = await Promise.all([
    jellyfin.countSeriesEpisodes(series.id),
    jellyfin.countSeriesEpisodes(series.id, { hasSubtitles: true }),
  ]);

  return {
    kind: "series",
    title: series.name,
    episodes: { total, withSubtitles },
  };
}

export async function buildMovieSubtitleCoverage(
  jellyfin: JellyfinClient,
  movie: JellyfinItem,
): Promise<MovieSubtitleCoverage> {
  const hasSubtitles = await jellyfin.movieHasSubtitles(movie.id);
  return {
    kind: "movie",
    title: displayTitleWithYear(movie),
    hasSubtitles,
  };
}

export function formatSubtitleCoverageMessage(report: SubtitleCoverageReport): string {
  if (report.kind === "library") {
    const overall = combineCoverageSlices([report.movies, report.episodes]);
    const lines = [
      "**Subtitle coverage (Jellyfin)**",
      "",
      formatCoverageLine("Movies", report.movies),
      formatCoverageLine("TV episodes", report.episodes),
      formatCoverageLine("Overall", overall),
    ];

    if (report.quoteIndex) {
      const indexPercent = formatCoveragePercent({
        withSubtitles: report.quoteIndex.itemCount,
        total: report.jellyfinSubtitledTotal,
      });
      lines.push(
        "",
        `**/quote index:** ${report.quoteIndex.itemCount.toLocaleString()} / ${report.jellyfinSubtitledTotal.toLocaleString()} Jellyfin subtitled items (${indexPercent})`,
      );
      if (report.quoteIndex.lastIndexedAt) {
        lines.push(`Last indexed: ${report.quoteIndex.lastIndexedAt}`);
      }
    } else {
      lines.push("", "_No /quote subtitle index found yet. Run `make index-subtitles` on the host._");
    }

    lines.push("", "_Counts use Jellyfin's `HasSubtitles` flag on your configured movie and TV libraries._");
    return lines.join("\n");
  }

  if (report.kind === "series") {
    const percent = formatCoveragePercent(report.episodes);
    return [
      `**${report.title}**`,
      "",
      `${report.episodes.withSubtitles.toLocaleString()} / ${report.episodes.total.toLocaleString()} episodes (${percent}) have subtitles in Jellyfin.`,
      "",
      "_Based on Jellyfin's `HasSubtitles` metadata for episodes in this series._",
    ].join("\n");
  }

  const status = report.hasSubtitles
    ? "has subtitles in Jellyfin."
    : "does **not** have subtitles in Jellyfin.";
  return [`**${report.title}**`, "", `This movie ${status}`].join("\n");
}
