import type { ApplicationCommandOptionChoiceData } from "discord.js";
import type { QuoteSearchResult } from "../subtitles/index-db.ts";
import { buildQuoteSuggestions } from "../services/quote-search-service.ts";
import { truncateLabel } from "./quote-suggestion-label.ts";

const MAX_CHOICE_NAME = 100;

export { buildQuoteChoiceLabel } from "./quote-suggestion-label.ts";

export function quoteSearchChoices(results: QuoteSearchResult[]): ApplicationCommandOptionChoiceData[] {
  return buildQuoteSuggestions(results).map((suggestion) => ({
    name: truncateLabel(suggestion.label, MAX_CHOICE_NAME),
    value: suggestion.token,
  }));
}

export { buildQuoteSuggestions } from "../services/quote-search-service.ts";
