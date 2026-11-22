import { afterEach, describe, expect, test } from "bun:test";
import { startHealthServer, type HealthState } from "../src/health.ts";

describe("health server (#230)", () => {
  const servers: Array<ReturnType<typeof startHealthServer>> = [];

  afterEach(() => {
    for (const server of servers) {
      server.stop(true);
    }
    servers.length = 0;
  });

  test("reports disconnected and 503 when discordReady is false", async () => {
    const state: HealthState = {
      discordReady: false,
      lastDiscordInteractionAt: null,
    };
    const server = startHealthServer(0, "test", () => state);
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      discord: string;
      lastDiscordInteractionAt: string | null;
    };
    expect(body.discord).toBe("disconnected");
    expect(body.lastDiscordInteractionAt).toBeNull();
  });

  test("reports connected and last interaction timestamp when ready", async () => {
    const stamp = "2026-11-22T00:21:00.000Z";
    const state: HealthState = {
      discordReady: true,
      lastDiscordInteractionAt: stamp,
    };
    const server = startHealthServer(0, "test", () => state);
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      discord: string;
      lastDiscordInteractionAt: string | null;
    };
    expect(body.discord).toBe("connected");
    expect(body.lastDiscordInteractionAt).toBe(stamp);
  });
});
