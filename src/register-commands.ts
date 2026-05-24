import { REST, Routes } from "discord.js";
import "dotenv/config";
import { clipCommand } from "./commands/clip.ts";
import { quoteCommand } from "./commands/quote.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);
const body = [clipCommand.toJSON(), quoteCommand.toJSON()];

const guildIds = config.discordGuildIds;

if (guildIds.length > 0) {
  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), { body });
    console.info(`Registered guild commands for ${guildId}`);
  }
} else {
  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  console.info("Registered global commands");
}
