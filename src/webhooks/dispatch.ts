import type { JellyfinClient, JellyfinItem } from "../jellyfin.ts";
import { indexJellyfinItem, type IndexSingleItemResult } from "../subtitles/indexer.ts";
import type { WebhookKick } from "./types.ts";
import { kickKey } from "./types.ts";

export type DispatchConfig = {
  subtitleDbPath: string;
  preferredLanguages: string[];
  /** Webhook coalesce window. Multiple kicks with the same key collapse into one. */
  debounceMs: number;
  /** Cap on poll-for-item retries before we give up waiting on Jellyfin. */
  pollMaxAttempts: number;
  /** Poll interval (constant, no exponential backoff - keeps test math simple). */
  pollIntervalMs: number;
  /**
   * Pause after Jellyfin's per-item refresh before reading media streams. The
   * item-refresh endpoint writes metadata asynchronously; without this the
   * indexer can read a stale stream probe and skip a fresh sub track.
   */
  postRefreshSettleMs: number;
};

export type DispatchDeps = {
  jellyfin: JellyfinClient;
  config: DispatchConfig;
  /** Override for tests. Defaults to the real indexer + setTimeout. */
  indexer?: typeof indexJellyfinItem;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type DispatchResult =
  | { ok: true; deduped: true }
  | { ok: true; deduped: false; queued: true }
  | { ok: false; reason: "ignored"; message: string };

/**
 * Schedule an indexer kick for a parsed webhook. Kicks for the same item
 * coalesce within `debounceMs` so a movie import + multiple subtitle fetches
 * resolve to a single targeted index run. Each kick logs its own
 * `webhook.dispatch` event so operators can correlate Connect events with
 * indexer activity.
 */
export class WebhookDispatcher {
  // setTimeout's return type differs across runtimes (Bun vs Node vs DOM).
  // Storing as ReturnType<typeof setTimeout> would lock us to one; using
  // unknown here and a typed clearTimeout adapter at the call site keeps the
  // dispatcher injectable in tests.
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: DispatchDeps) {}

  enqueue(kick: WebhookKick): DispatchResult {
    const key = kickKey(kick);
    // Cast through unknown: setTimeout/clearTimeout signatures vary across
    // Bun/Node/DOM. We only round-trip the handle through our own pending Map
    // so we don't actually care which underlying type comes back.
    const setTimeoutFn = (this.deps.setTimeout ?? globalThis.setTimeout) as (
      cb: () => void,
      ms: number,
    ) => ReturnType<typeof setTimeout>;
    const clearTimeoutFn = (this.deps.clearTimeout ?? globalThis.clearTimeout) as (
      handle: ReturnType<typeof setTimeout>,
    ) => void;

    const existing = this.pending.get(key);
    if (existing) {
      clearTimeoutFn(existing);
      console.info(
        JSON.stringify({
          event: "webhook.dispatch.coalesced",
          key,
          source: kick.source,
          eventType: kick.eventType,
        }),
      );
    }

    const handle = setTimeoutFn(() => {
      this.pending.delete(key);
      const work = this.runKick(kick).catch((error) => {
        console.error(
          JSON.stringify({
            event: "webhook.dispatch.unhandled_error",
            key,
            source: kick.source,
            eventType: kick.eventType,
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
      });
      this.inFlight.set(key, work);
      void work.finally(() => {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      });
    }, this.deps.config.debounceMs);

    this.pending.set(key, handle);

    return existing
      ? { ok: true, deduped: true }
      : { ok: true, deduped: false, queued: true };
  }

  /**
   * Wait for any currently-queued or running kicks to settle. Mostly useful
   * for tests; callers in production rely on log events, not promises.
   */
  async drain(): Promise<void> {
    while (this.pending.size > 0 || this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
      const sleep = this.deps.sleep ?? defaultSleep;
      if (this.pending.size > 0) {
        await sleep(this.deps.config.debounceMs + 5);
      }
    }
  }

  private async runKick(kick: WebhookKick): Promise<void> {
    const indexer = this.deps.indexer ?? indexJellyfinItem;
    const sleep = this.deps.sleep ?? defaultSleep;
    const key = kickKey(kick);
    const startedAt = Date.now();

    try {
      // Bazarr sub-only changes don't always bump dateLastRefreshed; force a
      // library refresh first so Jellyfin re-reads media streams. For Radarr
      // on-import the file is already in the folder but Jellyfin hasn't
      // scanned yet - same call covers that.
      try {
        await this.deps.jellyfin.triggerLibraryRefresh();
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "webhook.dispatch.refresh_failed",
            key,
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
      }

      const item = await this.pollForItem(kick, sleep);
      if (!item) {
        console.warn(
          JSON.stringify({
            event: "webhook.dispatch.item_not_found",
            key,
            source: kick.source,
            eventType: kick.eventType,
            elapsedMs: Date.now() - startedAt,
          }),
        );
        return;
      }

      // Force-refresh just this item so Bazarr SRT drops bump dateLastRefreshed
      // before we reach the indexer's incremental skip check.
      try {
        await this.deps.jellyfin.refreshItem(item.id);
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "webhook.dispatch.item_refresh_failed",
            key,
            itemId: item.id,
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
      }

      await sleep(this.deps.config.postRefreshSettleMs);

      const result: IndexSingleItemResult = await indexer(this.deps.jellyfin, {
        dbPath: this.deps.config.subtitleDbPath,
        itemId: item.id,
        preferredLanguages: this.deps.config.preferredLanguages,
      });

      console.info(
        JSON.stringify({
          event: result.ok ? "webhook.dispatch.indexed" : "webhook.dispatch.skipped",
          key,
          source: kick.source,
          eventType: kick.eventType,
          itemId: item.id,
          cueCount: result.ok ? result.cueCount : 0,
          reason: result.ok ? null : result.reason,
          message: result.ok ? null : result.message ?? null,
          elapsedMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "webhook.dispatch.error",
          key,
          source: kick.source,
          eventType: kick.eventType,
          error: error instanceof Error ? error.message : "unknown error",
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }
  }

  private async pollForItem(
    kick: WebhookKick,
    sleep: (ms: number) => Promise<void>,
  ): Promise<JellyfinItem | null> {
    const { pollMaxAttempts, pollIntervalMs } = this.deps.config;
    for (let attempt = 0; attempt < pollMaxAttempts; attempt += 1) {
      try {
        const found = await this.lookupItem(kick);
        if (found) return found;
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "webhook.dispatch.lookup_error",
            key: kickKey(kick),
            attempt,
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
      }
      if (attempt < pollMaxAttempts - 1) {
        await sleep(pollIntervalMs);
      }
    }
    return null;
  }

  private async lookupItem(kick: WebhookKick): Promise<JellyfinItem | null> {
    if (kick.kind === "movie") {
      if (kick.tmdbId != null) {
        return this.deps.jellyfin.findItemByTmdbId(kick.tmdbId, { title: kick.title });
      }
      return null;
    }
    return this.deps.jellyfin.findEpisodeByTvdb(
      kick.tvdbId,
      kick.seasonNumber,
      kick.episodeNumber,
      { seriesTitle: kick.title },
    );
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
