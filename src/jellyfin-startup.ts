import type { AppConfig } from "./config.ts";
import type { HealthState } from "./health.ts";
import type { JellyfinClient } from "./jellyfin.ts";
import { indexSubtitles } from "./subtitles/indexer.ts";
import { parsePreferredLanguages } from "./subtitles/track-select.ts";

export type JellyfinStartupOptions = {
  jellyfin: JellyfinClient;
  config: Pick<AppConfig, "subtitleDbPath" | "subtitleLanguages" | "subtitleIndexOnStartup" | "subtitleIndexConcurrency">;
  healthState: HealthState;
  onSubtitleIndexDone?: () => void;
};

/**
 * Authenticate to Jellyfin in the background so Discord can connect even when
 * Jellyfin is temporarily unavailable (e.g. missing metadata mount).
 */
export function startJellyfinConnectionLoop(options: JellyfinStartupOptions): void {
  void connectJellyfinWithRetry(options);
}

async function connectJellyfinWithRetry(options: JellyfinStartupOptions): Promise<void> {
  const { jellyfin, config, healthState, onSubtitleIndexDone } = options;
  let attempt = 0;

  while (true) {
    const delayMs =
      attempt === 0 ? 0 : Math.min(60_000, 5_000 * 2 ** Math.min(attempt - 1, 4));
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }
    attempt += 1;

    try {
      await jellyfin.authenticate();
      healthState.jellyfinUser = jellyfin.userName;
      console.info(
        JSON.stringify({
          event: "jellyfin.authenticated",
          user: jellyfin.userName,
          attempt,
        }),
      );

      if (config.subtitleIndexOnStartup === "incremental") {
        void indexSubtitles(jellyfin, {
          dbPath: config.subtitleDbPath,
          preferredLanguages: parsePreferredLanguages(config.subtitleLanguages),
          concurrency: config.subtitleIndexConcurrency,
          incremental: true,
          onProgress(event) {
            if (event.type === "done") {
              onSubtitleIndexDone?.();
            }
            console.info(JSON.stringify({ event: "subtitle_index.background", ...event }));
          },
        }).catch((error) => {
          console.error(
            JSON.stringify({
              event: "subtitle_index.background_failed",
              error: error instanceof Error ? error.message : "unknown error",
            }),
          );
        });
      }

      return;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "jellyfin.auth_failed",
          attempt,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }
}
