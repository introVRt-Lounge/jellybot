/**
 * Bun Worker entry: readonly SQLite FTS for /quote autocomplete.
 * Keeps heavy search off the Discord gateway event loop (#192).
 */
import {
  openSubtitleIndex,
  type QuoteFromChoice,
  type QuoteSearchResult,
  type QuoteSearchScope,
} from "./index-db.ts";

type SearchWorkerRequest =
  | {
      id: number;
      op: "search";
      dbPath: string;
      query: string;
      limit: number;
      scope?: QuoteSearchScope;
    }
  | {
      id: number;
      op: "series";
      dbPath: string;
      prefix: string;
      limit: number;
    }
  | {
      id: number;
      op: "from";
      dbPath: string;
      prefix: string;
      limit: number;
    };

type SearchWorkerResponse =
  | { id: number; ok: true; op: "search"; results: QuoteSearchResult[] }
  | { id: number; ok: true; op: "series"; names: string[] }
  | { id: number; ok: true; op: "from"; choices: QuoteFromChoice[] }
  | { id: number; ok: false; error: string };

const indexes = new Map<string, ReturnType<typeof openSubtitleIndex>>();

function getIndex(dbPath: string) {
  let index = indexes.get(dbPath);
  if (!index) {
    index = openSubtitleIndex(dbPath, { readonly: true });
    indexes.set(dbPath, index);
  }
  return index;
}

addEventListener("message", (event: MessageEvent<SearchWorkerRequest>) => {
  const msg = event.data;
  try {
    const index = getIndex(msg.dbPath);
    if (msg.op === "search") {
      const results = index.searchQuotes(msg.query, msg.limit, msg.scope);
      postMessage({ id: msg.id, ok: true, op: "search", results } satisfies SearchWorkerResponse);
      return;
    }

    if (msg.op === "from") {
      const choices = index.listQuoteFromTitles(msg.prefix, msg.limit);
      postMessage({ id: msg.id, ok: true, op: "from", choices } satisfies SearchWorkerResponse);
      return;
    }

    const names = index.listSeriesNames(msg.prefix, msg.limit);
    postMessage({ id: msg.id, ok: true, op: "series", names } satisfies SearchWorkerResponse);
  } catch (error) {
    postMessage({
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    } satisfies SearchWorkerResponse);
  }
});
