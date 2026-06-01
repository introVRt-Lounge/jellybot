import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
  autoSyncSlashCommands,
  computeBodyHash,
  computeScopeKey,
  type CommandSyncStateStore,
} from "../src/discord/command-sync-auto.ts";
import {
  planCommandSync,
  type CommandRegistryClient,
} from "../src/discord/command-sync.ts";

const FORCE_ENV = "JELLYBOT_COMMAND_SYNC_FORCE";

function memoryStore(): CommandSyncStateStore & { snapshot: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getLastBodyHash: (scopeKey) => map.get(scopeKey) ?? null,
    setLastBodyHash: (scopeKey, hash) => {
      map.set(scopeKey, hash);
    },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

function mockRegistry() {
  const calls: { type: "global" | "guild"; guildId?: string; body: RESTPostAPIApplicationCommandsJSONBody[] }[] = [];
  let globals: RESTPostAPIApplicationCommandsJSONBody[] = [];
  const registry: CommandRegistryClient = {
    async getGlobalCommands() {
      return globals;
    },
    async putGlobalCommands(body) {
      globals = [...body];
      calls.push({ type: "global", body: [...body] });
    },
    async putGuildCommands(guildId, body) {
      calls.push({ type: "guild", guildId, body: [...body] });
    },
  };
  return { registry, calls };
}

const cmdA: RESTPostAPIApplicationCommandsJSONBody = {
  name: "alpha",
  description: "Alpha command",
  type: 1,
};
const cmdB: RESTPostAPIApplicationCommandsJSONBody = {
  name: "beta",
  description: "Beta command",
  type: 1,
};
const cmdAModified: RESTPostAPIApplicationCommandsJSONBody = {
  name: "alpha",
  description: "Alpha command (renamed description)",
  type: 1,
};

describe("computeBodyHash", () => {
  test("is stable for the same body", () => {
    expect(computeBodyHash([cmdA, cmdB])).toBe(computeBodyHash([cmdA, cmdB]));
  });

  test("is order-independent", () => {
    expect(computeBodyHash([cmdA, cmdB])).toBe(computeBodyHash([cmdB, cmdA]));
  });

  test("differs when a command's content changes", () => {
    expect(computeBodyHash([cmdA, cmdB])).not.toBe(computeBodyHash([cmdAModified, cmdB]));
  });

  test("differs when a command is added", () => {
    expect(computeBodyHash([cmdA])).not.toBe(computeBodyHash([cmdA, cmdB]));
  });
});

describe("computeScopeKey", () => {
  test("returns 'global' for global plans", () => {
    expect(computeScopeKey({ mode: "global", guildIds: [], mustClearGlobals: false })).toBe("global");
  });

  test("includes sorted guild ids for guild plans", () => {
    const a = computeScopeKey({ mode: "guild", guildIds: ["222", "111"], mustClearGlobals: true });
    const b = computeScopeKey({ mode: "guild", guildIds: ["111", "222"], mustClearGlobals: true });
    expect(a).toBe(b);
    expect(a).toContain("111");
    expect(a).toContain("222");
  });
});

describe("autoSyncSlashCommands", () => {
  beforeEach(() => {
    delete process.env[FORCE_ENV];
  });

  afterEach(() => {
    delete process.env[FORCE_ENV];
  });

  test("first run with no stored hash triggers a sync and persists the new hash", async () => {
    const store = memoryStore();
    const { registry, calls } = mockRegistry();
    const plan = planCommandSync(["g1"]);

    const outcome = await autoSyncSlashCommands({
      registry,
      body: [cmdA, cmdB],
      plan,
      store,
    });

    expect(outcome.kind).toBe("synced");
    if (outcome.kind === "synced") {
      expect(outcome.guildIds).toEqual(["g1"]);
      expect(store.getLastBodyHash(outcome.scopeKey)).toBe(outcome.bodyHash);
    }
    expect(calls.find((c) => c.type === "guild" && c.guildId === "g1")).toBeDefined();
  });

  test("matching hash is a no-op (no Discord calls, hash unchanged)", async () => {
    const store = memoryStore();
    const plan = planCommandSync(["g1"]);
    const body = [cmdA, cmdB];
    const hash = computeBodyHash(body);
    store.setLastBodyHash(computeScopeKey(plan), hash);

    const { registry, calls } = mockRegistry();
    const outcome = await autoSyncSlashCommands({ registry, body, plan, store });

    expect(outcome.kind).toBe("noop");
    expect(calls).toHaveLength(0);
  });

  test("changed body triggers a fresh sync and updates the hash", async () => {
    const store = memoryStore();
    const plan = planCommandSync(["g1"]);
    const oldHash = computeBodyHash([cmdA]);
    store.setLastBodyHash(computeScopeKey(plan), oldHash);

    const { registry, calls } = mockRegistry();
    const outcome = await autoSyncSlashCommands({
      registry,
      body: [cmdA, cmdB],
      plan,
      store,
    });

    expect(outcome.kind).toBe("synced");
    if (outcome.kind === "synced") {
      expect(outcome.bodyHash).not.toBe(oldHash);
      expect(store.getLastBodyHash(outcome.scopeKey)).toBe(outcome.bodyHash);
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  test("refuses to sync an empty body and does not touch the registry", async () => {
    const store = memoryStore();
    const plan = planCommandSync(["g1"]);
    store.setLastBodyHash(computeScopeKey(plan), "previous-hash");

    const { registry, calls } = mockRegistry();
    const outcome = await autoSyncSlashCommands({ registry, body: [], plan, store });

    expect(outcome.kind).toBe("refused_empty_body");
    expect(calls).toHaveLength(0);
    expect(store.getLastBodyHash(computeScopeKey(plan))).toBe("previous-hash");
  });

  test("skips when guild plan has no configured guild ids", async () => {
    const store = memoryStore();
    const plan = planCommandSync([]);
    plan.mode = "guild";

    const { registry, calls } = mockRegistry();
    const outcome = await autoSyncSlashCommands({
      registry,
      body: [cmdA],
      plan,
      store,
    });

    expect(outcome.kind).toBe("skipped_no_scope");
    expect(calls).toHaveLength(0);
  });

  test("force flag bypasses the hash gate", async () => {
    const store = memoryStore();
    const plan = planCommandSync(["g1"]);
    const body = [cmdA, cmdB];
    const hash = computeBodyHash(body);
    store.setLastBodyHash(computeScopeKey(plan), hash);

    const { registry, calls } = mockRegistry();
    const outcome = await autoSyncSlashCommands({
      registry,
      body,
      plan,
      store,
      force: true,
    });

    expect(outcome.kind).toBe("synced");
    expect(calls.length).toBeGreaterThan(0);
  });

  test("JELLYBOT_COMMAND_SYNC_FORCE=1 env var also bypasses the hash gate", async () => {
    process.env[FORCE_ENV] = "1";
    const store = memoryStore();
    const plan = planCommandSync(["g1"]);
    const body = [cmdA];
    store.setLastBodyHash(computeScopeKey(plan), computeBodyHash(body));

    const { registry, calls } = mockRegistry();
    const outcome = await autoSyncSlashCommands({ registry, body, plan, store });

    expect(outcome.kind).toBe("synced");
    expect(calls.length).toBeGreaterThan(0);
  });

  test("scope key change forces re-sync (e.g. guild added)", async () => {
    const store = memoryStore();
    const body = [cmdA];
    const oldPlan = planCommandSync(["g1"]);
    const oldOutcome = await autoSyncSlashCommands({
      registry: mockRegistry().registry,
      body,
      plan: oldPlan,
      store,
    });
    expect(oldOutcome.kind).toBe("synced");

    const newPlan = planCommandSync(["g1", "g2"]);
    const { registry, calls } = mockRegistry();
    const newOutcome = await autoSyncSlashCommands({
      registry,
      body,
      plan: newPlan,
      store,
    });

    expect(newOutcome.kind).toBe("synced");
    expect(calls.filter((c) => c.type === "guild").length).toBe(2);
  });
});
