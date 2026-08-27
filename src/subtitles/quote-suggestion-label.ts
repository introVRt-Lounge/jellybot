import { formatEpisodeLabel } from "../jellyfin.ts";
import { displayTitleWithYear } from "../display-title.ts";
import type { QuoteSearchResult } from "./index-db.ts";
import { formatTimestamp } from "../time.ts";

export function buildQuoteChoiceLabel(result: QuoteSearchResult): string {
  const timestamp = formatTimestamp(result.startMs / 1000);
  const snippet = truncateLabel(result.text, 48);
  const title = buildMediaTitle(result);
  return `${title} @ ${timestamp} - ${snippet}`;
}

function buildMediaTitle(result: QuoteSearchResult): string {
  if (result.itemType === "Episode" && result.seriesName) {
    const episode = formatEpisodeLabel({
      name: result.title,
      type: result.itemType,
      seasonNumber: result.seasonNumber,
      episodeNumber: result.episodeNumber,
    });
    const show =
      result.seriesName.length > 28 ? `${result.seriesName.slice(0, 25)}...` : result.seriesName;
    return `${show} - ${episode}`;
  }

  if (result.productionYear) {
    return displayTitleWithYear({
      name: result.title,
      type: result.itemType,
      productionYear: result.productionYear,
    });
  }

  return result.title;
}

export function truncateLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
