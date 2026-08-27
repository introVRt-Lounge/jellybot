import { describe, expect, test } from "bun:test";
import type { HealthState } from "../src/health.ts";
import { JellyfinClient } from "../src/jellyfin.ts";
import { startJellyfinConnectionLoop } from "../src/jellyfin-startup.ts";

describe("startJellyfinConnectionLoop (#195)", () => {
  test("retries Jellyfin auth without throwing", async () => {
    const healthState: HealthState = { discordReady: false };
    const jellyfin = new JellyfinClient(
      "http://127.0.0.1:1",
      "user",
      "pass",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    let attempts = 0;
    jellyfin.authenticate = async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("Jellyfin authentication failed (500).");
      }
    };

    startJellyfinConnectionLoop({
      jellyfin,
      config: {
        subtitleDbPath: ":memory:",
        subtitleLanguages: "en",
        subtitleIndexOnStartup: "off",
        subtitleIndexConcurrency: 1,
      },
      healthState,
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (attempts >= 2) break;
      await Bun.sleep(100);
    }

    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
