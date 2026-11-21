import type {
  FtsMatchMode,
  QuoteFromChoice,
  QuoteSearchResult,
  QuoteSearchScope,
  SearchQuotesOptions,
} from "./index-db.ts";
import { getSubtitleSearchIndex } from "./search-index.ts";

type SearchWorkerRequest =
  | {
      id: number;
      op: "search";
      dbPath: string;
      query: string;
      limit: number;
      scope?: QuoteSearchScope;
      mode?: FtsMatchMode;
      orderBy?: SearchQuotesOptions["orderBy"];
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

    if (msg.op === "from") {
      entry.resolve(msg.choices);
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

type CallWorkerOptions = {
  interactive?: boolean;
  signal?: AbortSignal;
};

function callSearchWorker(
  request: Omit<Extract<SearchWorkerRequest, { op: "search" }>, "id">,
  timeoutMs: number,
  options: CallWorkerOptions = {},
): Promise<QuoteSearchResult[]> {
  return callWorker(request, timeoutMs, options) as Promise<QuoteSearchResult[]>;
}

function callSeriesWorker(
  request: Omit<Extract<SearchWorkerRequest, { op: "series" }>, "id">,
  timeoutMs: number,
  options: CallWorkerOptions = {},
): Promise<string[]> {
  return callWorker(request, timeoutMs, options) as Promise<string[]>;
}

function callFromWorker(
  request: Omit<Extract<SearchWorkerRequest, { op: "from" }>, "id">,
  timeoutMs: number,
  options: CallWorkerOptions = {},
): Promise<QuoteFromChoice[]> {
  return callWorker(request, timeoutMs, options) as Promise<QuoteFromChoice[]>;
}

function callWorker(
  request: Omit<SearchWorkerRequest, "id">,
  timeoutMs: number,
  options: CallWorkerOptions = {},
): Promise<unknown> {
  // `interactive` is intentional at the OffThreadSearchOptions layer (empty on
  // failure); callWorker never kills the shared worker for timeout/abort (#224/#226).
  const { signal } = options;

  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
  }

  const id = nextId++;
  nextId = nextId % Number.MAX_SAFE_INTEGER;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      handler();
    };

    const timer = setTimeout(() => {
      // Drop this request only. Do NOT terminateWorker() on budget timeout
      // (#224 / #226): killing the shared worker forces a cold reopen of the
      // multi-GB subtitle DB on the next keystroke and surfaces as Discord
      // "Loading options failed". Let the in-flight FTS finish; ignore the late
      // result (pending entry already removed).
      pending.delete(id);
      finish(() => reject(new Error("Subtitle search timed out")));
    }, timeoutMs);

    const onAbort = () => {
      // Drop this request only. Do NOT terminateWorker() on keystroke supersede
      // (#224): killing the shared worker forces a cold reopen of the multi-GB
      // subtitle DB on the next keystroke and surfaces as Discord
      // "Loading options failed" under typing storms.
      clearTimeout(timer);
      pending.delete(id);
      finish(() =>
        reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")),
      );
    };

    signal?.addEventListener("abort", onAbort);

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        pending.delete(id);
        finish(() => resolve(value));
      },
      reject: (error) => {
        clearTimeout(timer);
        pending.delete(id);
        finish(() => reject(error));
      },
      timer,
    });

    try {
      ensureWorker().postMessage({ ...request, id });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
      settled = true;
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
  /** When aborted (superseded keystroke), drop the worker request immediately. */
  signal?: AbortSignal;
  /** FTS match mode — phrase for short `/quote` autocomplete lines (#228). */
  mode?: FtsMatchMode;
  /** Skip SQLite bm25 sort for autocomplete; JS re-ranks (#228). */
  orderBy?: SearchQuotesOptions["orderBy"];
};

export async function searchQuotesOffThread(
  dbPath: string,
  query: string,
  limit: number,
  scope: QuoteSearchScope | undefined,
  timeoutMs: number,
  options: OffThreadSearchOptions = {},
): Promise<QuoteSearchResult[]> {
  const interactive = options.interactive ?? false;
  const { signal, mode, orderBy } = options;
  const ftsOptions: SearchQuotesOptions = {
    ...(mode ? { mode } : {}),
    ...(orderBy ? { orderBy } : {}),
  };

  if (signal?.aborted) {
    return [];
  }

  if (!workerEnabled()) {
    if (interactive) {
      logInteractiveWorkerUnavailable("search");
      return [];
    }
    return getSubtitleSearchIndex(dbPath).searchQuotes(query, limit, scope, ftsOptions);
  }

  try {
    return await callSearchWorker(
      {
        op: "search",
        dbPath,
        query,
        limit,
        scope,
        mode,
        orderBy,
      },
      timeoutMs,
      { interactive, signal },
    );
  } catch (error) {
    if (interactive && isBenignWorkerError(error, signal)) {
      return [];
    }

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
    return getSubtitleSearchIndex(dbPath).searchQuotes(query, limit, scope, ftsOptions);
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
  const { signal } = options;

  if (signal?.aborted) {
    return [];
  }

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
      { interactive, signal },
    );
  } catch (error) {
    if (interactive && isBenignWorkerError(error, signal)) {
      return [];
    }

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

export async function listQuoteFromTitlesOffThread(
  dbPath: string,
  prefix: string,
  limit: number,
  timeoutMs: number,
  options: OffThreadSearchOptions = {},
): Promise<QuoteFromChoice[]> {
  const interactive = options.interactive ?? false;
  const { signal } = options;

  if (signal?.aborted) {
    return [];
  }

  if (!workerEnabled()) {
    if (interactive) {
      logInteractiveWorkerUnavailable("from");
      return [];
    }
    return getSubtitleSearchIndex(dbPath).listQuoteFromTitles(prefix, limit);
  }

  try {
    return await callFromWorker(
      {
        op: "from",
        dbPath,
        prefix,
        limit,
      },
      timeoutMs,
      { interactive, signal },
    );
  } catch (error) {
    if (interactive && isBenignWorkerError(error, signal)) {
      return [];
    }

    console.warn(
      JSON.stringify({
        event: "subtitle_search.worker_failed",
        op: "from",
        interactive,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    terminateWorker();
    if (interactive) {
      return [];
    }
    return getSubtitleSearchIndex(dbPath).listQuoteFromTitles(prefix, limit);
  }
}

function isBenignWorkerError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    if (error.message === "Subtitle search timed out") return true;
    if (error.message === "Subtitle search worker terminated") return true;
  }
  return false;
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
