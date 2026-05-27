import { REST } from "discord.js";
import "dotenv/config";
import { clipCommand } from "./commands/clip.ts";
import { featureCommand } from "./commands/feature.ts";
import { quoteCommand } from "./commands/quote.ts";
import { loadConfig } from "./config.ts";
import {
  createRestCommandRegistry,
  planCommandSync,
  syncSlashCommands,
} from "./discord/command-sync.ts";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);
const body = [clipCommand.toJSON(), quoteCommand.toJSON(), featureCommand.toJSON()];
const plan = planCommandSync(config.discordGuildIds);
const registry = createRestCommandRegistry(rest, config.discordClientId);

const result = await syncSlashCommands(registry, body, plan);

if (plan.mode === "guild") {
  for (const guildId of result.guildIds) {
    console.info(`Registered guild commands for ${guildId}`);
  }
  if (result.globalsCleared > 0) {
    console.info(`Cleared ${result.globalsCleared} stale global command(s)`);
  } else {
    console.info("Global commands already empty (guild-scoped registration)");
  }
} else {
  console.info("Registered global commands");
}
