import { REST, Routes } from "discord.js";
import "dotenv/config";
import { clipCommand } from "./commands/clip.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);
const body = [clipCommand.toJSON()];

if (config.discordGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body });
  console.info(`Registered guild commands for ${config.discordGuildId}`);
} else {
  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  console.info("Registered global commands");
}
