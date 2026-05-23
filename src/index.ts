import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { handleClipAutocomplete, handleClipCommand } from "./commands/clip.ts";
import { loadConfig } from "./config.ts";
import { startHealthServer, type HealthState } from "./health.ts";
import { JellyfinClient } from "./jellyfin.ts";

const config = loadConfig();
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinUsername, config.jellyfinPassword);

const healthState: HealthState = {
  discordReady: false,
  jellyfinUser: undefined,
};

startHealthServer(config.healthPort, config.appVersion, () => healthState);
console.info(`Health server listening on :${config.healthPort}/healthz`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  healthState.discordReady = true;
  console.info(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== "clip") return;

    try {
      await handleClipAutocomplete(interaction, jellyfin);
    } catch (error) {
      console.error("Autocomplete error:", error);
      if (!interaction.responded) {
        await interaction.respond([]).catch(() => undefined);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== "clip") {
    return;
  }

  try {
    await handleClipCommand(interaction, jellyfin, config);
  } catch (error) {
    console.error("Command error:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("Something went wrong while handling that command.").catch(() => undefined);
      return;
    }

    await interaction.reply({
      content: "Something went wrong while handling that command.",
      ephemeral: true,
    }).catch(() => undefined);
  }
});

function shutdown(): void {
  client.destroy().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await jellyfin.authenticate();
healthState.jellyfinUser = jellyfin.userName;
console.info(`Authenticated to Jellyfin as ${jellyfin.userName}`);
await client.login(config.discordToken);
