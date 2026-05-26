import { describe, expect, test } from "bun:test";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
  ensureNoStaleGlobalCommands,
  planCommandSync,
  purgeGlobalCommands,
  syncSlashCommands,
  type CommandRegistryClient,
} from "../src/discord/command-sync.ts";

const sampleBody: RESTPostAPIApplicationCommandsJSONBody[] = [
  { name: "ping", description: "Ping", type: 1 },
];

function mockRegistry(initialGlobals: RESTPostAPIApplicationCommandsJSONBody[] = []) {
  let globals = [...initialGlobals];
  const guilds = new Map<string, RESTPostAPIApplicationCommandsJSONBody[]>();

  const registry: CommandRegistryClient = {
    async getGlobalCommands() {
      return globals;
    },
    async putGlobalCommands(body) {
      globals = [...body];
    },
    async putGuildCommands(guildId, body) {
      guilds.set(guildId, [...body]);
    },
  };

  return {
    registry,
    getGlobals: () => globals,
    getGuild: (guildId: string) => guilds.get(guildId) ?? [],
  };
}

describe("planCommandSync", () => {
  test("uses global mode when no guild ids are configured", () => {
    expect(planCommandSync([])).toEqual({
      mode: "global",
      guildIds: [],
      mustClearGlobals: false,
    });
  });

  test("uses guild mode and requires clearing globals when guild ids exist", () => {
    expect(planCommandSync(["111", " 222 ", ""])).toEqual({
      mode: "guild",
      guildIds: ["111", "222"],
      mustClearGlobals: true,
    });
  });
});

describe("syncSlashCommands", () => {
  test("registers globally when plan is global", async () => {
    const { registry, getGlobals } = mockRegistry([{ name: "old", description: "Old", type: 1 }]);
    const result = await syncSlashCommands(registry, sampleBody, planCommandSync([]));

    expect(result.globalsCleared).toBe(0);
    expect(getGlobals()).toEqual(sampleBody);
  });

  test("registers per guild and clears stale globals", async () => {
    const stale = [{ name: "quote", description: "Stale global", type: 1 }];
    const { registry, getGlobals, getGuild } = mockRegistry(stale);

    const result = await syncSlashCommands(
      registry,
      sampleBody,
      planCommandSync(["guild-a", "guild-b"]),
    );

    expect(result.globalsCleared).toBe(1);
    expect(getGlobals()).toEqual([]);
    expect(getGuild("guild-a")).toEqual(sampleBody);
    expect(getGuild("guild-b")).toEqual(sampleBody);
  });

  test("guild sync is idempotent when globals are already empty", async () => {
    const { registry, getGlobals } = mockRegistry([]);
    const result = await syncSlashCommands(registry, sampleBody, planCommandSync(["guild-a"]));

    expect(result.globalsCleared).toBe(0);
    expect(getGlobals()).toEqual([]);
  });
});

describe("ensureNoStaleGlobalCommands", () => {
  test("no-ops in global mode", async () => {
    const { registry } = mockRegistry([{ name: "old", description: "Old", type: 1 }]);
    const cleared = await ensureNoStaleGlobalCommands(registry, planCommandSync([]));
    expect(cleared).toBe(0);
  });

  test("purges stale globals on startup self-heal", async () => {
    const { registry, getGlobals } = mockRegistry([{ name: "quote", description: "Stale", type: 1 }]);
    const cleared = await ensureNoStaleGlobalCommands(registry, planCommandSync(["guild-a"]));

    expect(cleared).toBe(1);
    expect(getGlobals()).toEqual([]);
  });
});

describe("purgeGlobalCommands", () => {
  test("returns zero when nothing to purge", async () => {
    const { registry } = mockRegistry([]);
    expect(await purgeGlobalCommands(registry)).toBe(0);
  });
});
