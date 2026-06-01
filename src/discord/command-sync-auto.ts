import { createHash } from "node:crypto";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
  syncSlashCommands,
  type CommandRegistryClient,
  type CommandSyncPlan,
} from "./command-sync.ts";

export type CommandSyncStateStore = {
  getLastBodyHash: (scopeKey: string) => string | null;
  setLastBodyHash: (scopeKey: string, hash: string) => void;
};

export type AutoSyncOutcome =
  | { kind: "noop"; bodyHash: string; scopeKey: string }
  | { kind: "synced"; bodyHash: string; scopeKey: string; globalsCleared: number; guildIds: string[] }
  | { kind: "refused_empty_body"; scopeKey: string }
  | { kind: "skipped_no_scope" };

const FORCE_ENV = "JELLYBOT_COMMAND_SYNC_FORCE";

/**
 * Decides whether the current body needs to be pushed to Discord and runs the sync if so.
 * - Refuses to sync an empty body (defensive against accidental command wipes).
 * - Skips when the scope is "guild" but no guild ids are configured (no-op).
 * - Stable scope key combines mode + sorted guild ids so a guild add/remove forces a re-sync.
 * - Force override via `JELLYBOT_COMMAND_SYNC_FORCE=1` (or explicit `force` arg) bypasses the hash gate.
 */
export async function autoSyncSlashCommands(input: {
  registry: CommandRegistryClient;
  body: RESTPostAPIApplicationCommandsJSONBody[];
  plan: CommandSyncPlan;
  store: CommandSyncStateStore;
  force?: boolean;
}): Promise<AutoSyncOutcome> {
  const { registry, body, plan, store } = input;
  const scopeKey = computeScopeKey(plan);

  if (plan.mode === "guild" && plan.guildIds.length === 0) {
    return { kind: "skipped_no_scope" };
  }

  if (body.length === 0) {
    return { kind: "refused_empty_body", scopeKey };
  }

  const bodyHash = computeBodyHash(body);
  const force = input.force ?? process.env[FORCE_ENV] === "1";
  const lastHash = store.getLastBodyHash(scopeKey);

  if (!force && lastHash === bodyHash) {
    return { kind: "noop", bodyHash, scopeKey };
  }

  const result = await syncSlashCommands(registry, body, plan);
  store.setLastBodyHash(scopeKey, bodyHash);
  return {
    kind: "synced",
    bodyHash,
    scopeKey,
    globalsCleared: result.globalsCleared,
    guildIds: result.guildIds,
  };
}

export function computeBodyHash(body: RESTPostAPIApplicationCommandsJSONBody[]): string {
  // Deterministic stable serialization: sort top-level commands by name, sort each
  // command's keys recursively. Two equivalent bodies in any input order get the same hash.
  const canonical = body
    .map((cmd) => stableStringify(cmd))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function computeScopeKey(plan: CommandSyncPlan): string {
  if (plan.mode === "global") return "global";
  const ids = [...plan.guildIds].sort().join(",");
  return `guild:${ids}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}
