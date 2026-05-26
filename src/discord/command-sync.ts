import { REST, Routes } from "discord.js";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

export type CommandSyncMode = "guild" | "global";

export type CommandSyncPlan = {
  mode: CommandSyncMode;
  guildIds: string[];
  /** When guild-scoped, global commands must be empty to avoid duplicate autocomplete delivery. */
  mustClearGlobals: boolean;
};

export type CommandRegistryClient = {
  getGlobalCommands: () => Promise<RESTPostAPIApplicationCommandsJSONBody[]>;
  putGlobalCommands: (body: RESTPostAPIApplicationCommandsJSONBody[]) => Promise<void>;
  putGuildCommands: (guildId: string, body: RESTPostAPIApplicationCommandsJSONBody[]) => Promise<void>;
};

export function planCommandSync(guildIds: string[]): CommandSyncPlan {
  const ids = guildIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { mode: "global", guildIds: [], mustClearGlobals: false };
  }
  return { mode: "guild", guildIds: ids, mustClearGlobals: true };
}

export function createRestCommandRegistry(rest: REST, clientId: string): CommandRegistryClient {
  return {
    async getGlobalCommands() {
      return (await rest.get(Routes.applicationCommands(clientId))) as RESTPostAPIApplicationCommandsJSONBody[];
    },
    async putGlobalCommands(body) {
      await rest.put(Routes.applicationCommands(clientId), { body });
    },
    async putGuildCommands(guildId, body) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    },
  };
}

export async function purgeGlobalCommands(
  registry: CommandRegistryClient,
): Promise<number> {
  const existing = await registry.getGlobalCommands();
  if (existing.length === 0) return 0;
  await registry.putGlobalCommands([]);
  return existing.length;
}

/**
 * Register slash commands for the configured scope.
 * Guild-scoped registration always clears global commands first (idempotent).
 */
export async function syncSlashCommands(
  registry: CommandRegistryClient,
  body: RESTPostAPIApplicationCommandsJSONBody[],
  plan: CommandSyncPlan,
): Promise<{ globalsCleared: number; guildIds: string[] }> {
  if (plan.mode === "global") {
    await registry.putGlobalCommands(body);
    return { globalsCleared: 0, guildIds: [] };
  }

  let globalsCleared = 0;
  if (plan.mustClearGlobals) {
    globalsCleared = await purgeGlobalCommands(registry);
  }

  for (const guildId of plan.guildIds) {
    await registry.putGuildCommands(guildId, body);
  }

  return { globalsCleared, guildIds: plan.guildIds };
}

/**
 * Self-heal on bot startup: if guild-scoped, remove any leftover global commands.
 */
export async function ensureNoStaleGlobalCommands(
  registry: CommandRegistryClient,
  plan: CommandSyncPlan,
): Promise<number> {
  if (plan.mode !== "guild" || !plan.mustClearGlobals) return 0;
  return purgeGlobalCommands(registry);
}
