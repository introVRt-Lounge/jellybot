import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { handleClipAutocomplete, handleClipCommand } from "./commands/clip.ts";
import { handleQuoteAutocomplete, handleQuoteCommand } from "./commands/quote.ts";
import { loadConfig } from "./config.ts";
import { startHealthServer, type HealthState } from "./health.ts";
import { JellyfinClient } from "./jellyfin.ts";
import { indexSubtitles } from "./subtitles/indexer.ts";
import { openSubtitleIndex } from "./subtitles/index-db.ts";
import { parsePreferredLanguages } from "./subtitles/track-select.ts";

const config = loadConfig();
const jellyfin = new JellyfinClient(
  config.jellyfinUrl,
  config.jellyfinUsername,
  config.jellyfinPassword,
  config.jellyfinMoviesLibraryId,
  config.jellyfinTvLibraryId,
);

const healthState: HealthState = {
  discordReady: false,
  jellyfinUser: undefined,
  subtitleIndex: null,
};

let subtitleHealthCache: HealthState["subtitleIndex"] = null;
let subtitleHealthCheckedAt = 0;
const SUBTITLE_HEALTH_TTL_MS = 60_000;

function refreshSubtitleHealth(force = false): void {
  const now = Date.now();
  if (!force && subtitleHealthCache && now - subtitleHealthCheckedAt < SUBTITLE_HEALTH_TTL_MS) {
    healthState.subtitleIndex = subtitleHealthCache;
    return;
  }

  try {
    const index = openSubtitleIndex(config.subtitleDbPath);
    try {
      subtitleHealthCache = index.getStats();
      subtitleHealthCheckedAt = now;
      healthState.subtitleIndex = subtitleHealthCache;
    } finally {
      index.close();
    }
  } catch {
    subtitleHealthCache = null;
    subtitleHealthCheckedAt = now;
    healthState.subtitleIndex = null;
  }
}

startHealthServer(config.healthPort, config.appVersion, () => {
  refreshSubtitleHealth();
  return healthState;
});
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
    if (interaction.commandName === "clip") {
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

    if (interaction.commandName === "quote") {
      try {
        await handleQuoteAutocomplete(interaction, jellyfin, config);
      } catch (error) {
        console.error("Quote autocomplete error:", error);
        if (!interaction.responded) {
          await interaction.respond([]).catch(() => undefined);
        }
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "clip") {
    try {
      await handleClipCommand(interaction, jellyfin, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "clip.error",
          command: "clip",
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          error: error instanceof Error ? error.message : "unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong while handling that command.").catch(() => undefined);
        return;
      }

      await interaction
        .reply({
          content: "Something went wrong while handling that command.",
          ephemeral: true,
        })
        .catch(() => undefined);
    }
    return;
  }

  if (interaction.commandName === "quote") {
    try {
      await handleQuoteCommand(interaction, jellyfin, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "quote.error",
          command: "quote",
          userId: interaction.user.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong while handling that command.").catch(() => undefined);
        return;
      }

      await interaction
        .reply({
          content: "Something went wrong while handling that command.",
          ephemeral: true,
        })
        .catch(() => undefined);
    }
  }
});

function shutdown(): void {
  client.destroy().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await jellyfin.authenticate();
healthState.jellyfinUser = jellyfin.userName;
refreshSubtitleHealth();
console.info(`Authenticated to Jellyfin as ${jellyfin.userName}`);

if (config.subtitleIndexOnStartup === "incremental") {
  void indexSubtitles(jellyfin, {
    dbPath: config.subtitleDbPath,
    preferredLanguages: parsePreferredLanguages(config.subtitleLanguages),
    concurrency: config.subtitleIndexConcurrency,
    incremental: true,
    onProgress(event) {
      if (event.type === "done") {
        refreshSubtitleHealth();
      }
      console.info(JSON.stringify({ event: "subtitle_index.background", ...event }));
    },
  }).catch((error) => {
    console.error(
      JSON.stringify({
        event: "subtitle_index.background_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
  });
}

await client.login(config.discordToken);
