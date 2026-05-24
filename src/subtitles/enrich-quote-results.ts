import { displayTitle } from "../display-title.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import type { QuoteSearchResult } from "./index-db.ts";

export async function enrichQuoteSearchResults(
  jellyfin: JellyfinClient,
  results: QuoteSearchResult[],
): Promise<QuoteSearchResult[]> {
  if (results.length === 0) return results;

  const itemIds = [...new Set(results.map((result) => result.itemId))];
  const items = await Promise.all(itemIds.map((itemId) => jellyfin.getItem(itemId)));
  const byId = new Map(items.flatMap((item) => (item ? [[item.id, item] as const] : [])));

  return results.map((result) => {
    const item = byId.get(result.itemId);
    if (!item) return result;

    return {
      ...result,
      title: displayTitle(item),
      seriesName: item.seriesName ?? result.seriesName,
    };
  });
}
