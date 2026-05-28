import { describe, expect, test } from "bun:test";
import {
  combineCoverageSlices,
  coveragePercent,
  formatCoverageLine,
  formatCoveragePercent,
  formatSubtitleCoverageMessage,
  type LibrarySubtitleCoverage,
  type MovieSubtitleCoverage,
  type SeriesSubtitleCoverage,
} from "../src/services/subtitle-coverage.ts";

describe("subtitle coverage formatting", () => {
  test("computes percentage with one decimal", () => {
    expect(coveragePercent({ withSubtitles: 82, total: 100 })).toBe(82);
    expect(formatCoveragePercent({ withSubtitles: 1, total: 3 })).toBe("33.3%");
    expect(formatCoveragePercent({ withSubtitles: 0, total: 0 })).toBe("n/a");
  });

  test("formats coverage lines with thousands separators", () => {
    expect(formatCoverageLine("Movies", { withSubtitles: 1200, total: 1500 })).toBe(
      "**Movies:** 1,200 / 1,500 (80.0%)",
    );
  });

  test("combines movie and episode slices for overall totals", () => {
    expect(
      combineCoverageSlices([
        { withSubtitles: 10, total: 20 },
        { withSubtitles: 30, total: 40 },
      ]),
    ).toEqual({ withSubtitles: 40, total: 60 });
  });

  test("formats library report with quote index context", () => {
    const report: LibrarySubtitleCoverage = {
      kind: "library",
      movies: { withSubtitles: 8, total: 10 },
      episodes: { withSubtitles: 45, total: 90 },
      jellyfinSubtitledTotal: 60,
      quoteIndex: {
        itemCount: 40,
        cueCount: 1000,
        lastIndexedAt: "2026-05-01T12:00:00.000Z",
      },
    };

    const message = formatSubtitleCoverageMessage(report);
    expect(message).toContain("**Subtitle coverage (Jellyfin)**");
    expect(message).toContain("**Overall:** 53 / 100 (53.0%)");
    expect(message).toContain("**/quote index:** 40 / 60");
    expect(message).toContain("Last indexed: 2026-05-01T12:00:00.000Z");
  });

  test("formats series and movie scoped reports", () => {
    const series: SeriesSubtitleCoverage = {
      kind: "series",
      title: "Breaking Bad",
      episodes: { withSubtitles: 50, total: 62 },
    };
    expect(formatSubtitleCoverageMessage(series)).toContain("Breaking Bad");
    expect(formatSubtitleCoverageMessage(series)).toContain("80.6%");

    const movie: MovieSubtitleCoverage = {
      kind: "movie",
      title: "The Matrix (1999)",
      hasSubtitles: false,
    };
    expect(formatSubtitleCoverageMessage(movie)).toContain("does **not** have subtitles");
  });
});
