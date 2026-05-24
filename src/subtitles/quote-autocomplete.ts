import type { ApplicationCommandOptionChoiceData } from "discord.js";
import { formatEpisodeLabel } from "../jellyfin.ts";
import { displayTitleWithYear } from "../display-title.ts";
import { encodeQuoteMatchToken } from "../subtitles/match-token.ts";
import type { QuoteSearchResult } from "../subtitles/index-db.ts";
import { formatTimestamp } from "../time.ts";

const MAX_CHOICE_NAME = 100;
const MAX_CHOICES = 25;

export function quoteSearchChoices(results: QuoteSearchResult[]): ApplicationCommandOptionChoiceData[] {
  const seen = new Set<string>();
  const choices: ApplicationCommandOptionChoiceData[] = [];

  for (const result of results) {
    const value = encodeQuoteMatchToken({
      itemId: result.itemId,
      startMs: result.startMs,
      endMs: result.endMs,
    }).slice(0, 100);

    if (seen.has(value)) continue;
    seen.add(value);

    const name = truncate(buildQuoteChoiceLabel(result), MAX_CHOICE_NAME);
    choices.push({ name, value });
    if (choices.length >= MAX_CHOICES) break;
  }

  return choices;
}

export function buildQuoteChoiceLabel(result: QuoteSearchResult): string {
  const timestamp = formatTimestamp(result.startMs / 1000);
  const snippet = truncate(result.text, 48);
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

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
