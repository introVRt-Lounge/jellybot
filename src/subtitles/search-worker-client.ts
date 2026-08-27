import type { QuoteSearchResult } from "./index-db.ts";
import { getSubtitleSearchIndex } from "./search-index.ts";

type SearchWorkerRequest =
  | {
      id: number;
      op: "search";
      dbPath: string;
      query: string;
      limit: number;
      seriesFilter?: string;
    }
  | {
      id: number;
      op: "series";
      dbPath: string;
      prefix: string;
      limit: number;
    };

type SearchWorkerResponse =
  | { id: number; ok: true; op: "search"; results: QuoteSearchResult[] }
  | { id: number; ok: true; op: "series"; names: string[] }
  | { id: number; ok: false; error: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function workerEnabled(): boolean {
  return process.env.JELLYBOT_SUBTITLE_SEARCH_WORKER !== "0";
}

function terminateWorker(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Subtitle search worker terminated"));
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./search-worker-thread.ts", import.meta.url).href, {
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(msg.id);

    if (!msg.ok) {
      entry.reject(new Error(msg.error));
      return;
    }

    if (msg.op === "search") {
      entry.resolve(msg.results);
      return;
    }

    entry.resolve(msg.names);
  };

  worker.onerror = (error) => {
    console.error(
      JSON.stringify({
        event: "subtitle_search.worker_error",
        error: error.message ?? "unknown worker error",
      }),
    );
    terminateWorker();
  };

  return worker;
}

function callSearchWorker(
  request: Omit<Extract<SearchWorkerRequest, { op: "search" }>, "id">,
  timeoutMs: number,
): Promise<QuoteSearchResult[]> {
  return callWorker(request, timeoutMs) as Promise<QuoteSearchResult[]>;
}

function callSeriesWorker(
  request: Omit<Extract<SearchWorkerRequest, { op: "series" }>, "id">,
  timeoutMs: number,
): Promise<string[]> {
  return callWorker(request, timeoutMs) as Promise<string[]>;
}

function callWorker(request: Omit<SearchWorkerRequest, "id">, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  nextId = nextId % Number.MAX_SAFE_INTEGER;

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Subtitle search timed out"));
    }, timeoutMs);

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });

    try {
      ensureWorker().postMessage({ ...request, id });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

export type OffThreadSearchOptions = {
  /**
   * Autocomplete / slash-command path: never fall back to synchronous FTS on the
   * gateway thread. Return [] on worker failure so Discord gets a fast ack.
   */
  interactive?: boolean;
};

export async function searchQuotesOffThread(
  dbPath: string,
  query: string,
  limit: number,
  seriesFilter: string | undefined,
  timeoutMs: number,
  options: OffThreadSearchOptions = {},
): Promise<QuoteSearchResult[]> {
  const interactive = options.interactive ?? false;

  if (!workerEnabled()) {
    if (interactive) {
      logInteractiveWorkerUnavailable("search");
      return [];
    }
    return getSubtitleSearchIndex(dbPath).searchQuotes(query, limit, seriesFilter);
  }

  try {
    return await callSearchWorker(
      {
        op: "search",
        dbPath,
        query,
        limit,
        seriesFilter,
      },
      timeoutMs,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "subtitle_search.worker_failed",
        op: "search",
        interactive,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    terminateWorker();
    if (interactive) {
      return [];
    }
    return getSubtitleSearchIndex(dbPath).searchQuotes(query, limit, seriesFilter);
  }
}

export async function listSeriesNamesOffThread(
  dbPath: string,
  prefix: string,
  limit: number,
  timeoutMs: number,
  options: OffThreadSearchOptions = {},
): Promise<string[]> {
  const interactive = options.interactive ?? false;

  if (!workerEnabled()) {
    if (interactive) {
      logInteractiveWorkerUnavailable("series");
      return [];
    }
    return getSubtitleSearchIndex(dbPath).listSeriesNames(prefix, limit);
  }

  try {
    return await callSeriesWorker(
      {
        op: "series",
        dbPath,
        prefix,
        limit,
      },
      timeoutMs,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "subtitle_search.worker_failed",
        op: "series",
        interactive,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    terminateWorker();
    if (interactive) {
      return [];
    }
    return getSubtitleSearchIndex(dbPath).listSeriesNames(prefix, limit);
  }
}

function logInteractiveWorkerUnavailable(op: string): void {
  console.warn(
    JSON.stringify({
      event: "subtitle_search.worker_unavailable",
      op,
      hint: "Set JELLYBOT_SUBTITLE_SEARCH_WORKER=1 (default) for /quote autocomplete",
    }),
  );
}

/** Test-only teardown. */
export function shutdownSubtitleSearchWorkerForTests(): void {
  terminateWorker();
}
