import "dotenv/config";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Client, Events, GatewayIntentBits, REST } from "discord.js";
import {
  handleClipPreviewButton,
  handleClipPreviewModal,
  isClipPreviewButton,
  isClipPreviewModal,
} from "./clip-preview/handlers.ts";
import { handleClipAutocomplete, handleClipCommand } from "./commands/clip.ts";
import { handleQuoteAutocomplete, handleQuoteCommand } from "./commands/quote.ts";
import { loadConfig } from "./config.ts";
import {
  createRestCommandRegistry,
  ensureNoStaleGlobalCommands,
  planCommandSync,
} from "./discord/command-sync.ts";
import { startHealthServer, type HealthState } from "./health.ts";
import { JellyfinClient } from "./jellyfin.ts";
import { indexSubtitles } from "./subtitles/indexer.ts";
import { openSubtitleIndex } from "./subtitles/index-db.ts";
import { parsePreferredLanguages } from "./subtitles/track-select.ts";
import { createReleaseAnnouncerFromConfig } from "./release/release-announcer.ts";
import { looksLikeReleaseTag } from "./release/semver.ts";
import { isBenignAutocompleteError } from "./autocomplete-guard.ts";

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
  releaseTag: looksLikeReleaseTag(config.appVersion) ? config.appVersion : null,
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

const gatewayInstanceId = randomUUID().slice(0, 8);

client.once(Events.ClientReady, async (readyClient) => {
  healthState.discordReady = true;
  console.info(
    JSON.stringify({
      event: "discord.ready",
      tag: readyClient.user.tag,
      instanceId: gatewayInstanceId,
      hostname: hostname(),
      appVersion: config.appVersion,
    }),
  );

  const commandSyncPlan = planCommandSync(config.discordGuildIds);
  if (commandSyncPlan.mode === "guild") {
    try {
      const rest = new REST({ version: "10" }).setToken(config.discordToken);
      const registry = createRestCommandRegistry(rest, config.discordClientId);
      const cleared = await ensureNoStaleGlobalCommands(registry, commandSyncPlan);
      if (cleared > 0) {
        console.warn(
          JSON.stringify({
            event: "discord.commands.stale_globals_purged",
            cleared,
            guildIds: commandSyncPlan.guildIds,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "discord.commands.stale_globals_purge_failed",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }

  const announcer = createReleaseAnnouncerFromConfig(config);
  if (announcer) {
    try {
      const tag = await announcer.checkAndAnnounceNewRelease(client);
      if (tag && looksLikeReleaseTag(tag)) {
        healthState.releaseTag = tag;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "release_announcer.failed",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }
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
        if (!isBenignAutocompleteError(error)) {
          console.error("Quote autocomplete error:", error);
        }
        if (!interaction.responded) {
          await interaction.respond([]).catch(() => undefined);
        }
      }
    }
    return;
  }

  if (interaction.isButton() && isClipPreviewButton(interaction)) {
    try {
      await handleClipPreviewButton(interaction, jellyfin, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "clip_preview.button_error",
          userId: interaction.user.id,
          customId: interaction.customId,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong with that action.", ephemeral: true }).catch(() => undefined);
      }
    }
    return;
  }

  if (interaction.isModalSubmit() && isClipPreviewModal(interaction)) {
    try {
      await handleClipPreviewModal(interaction, jellyfin, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "clip_preview.modal_error",
          userId: interaction.user.id,
          customId: interaction.customId,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong while re-rendering.", ephemeral: true }).catch(() => undefined);
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

if (process.env.JELLYBOT_DISABLE_DISCORD_GATEWAY === "1") {
  console.warn(
    JSON.stringify({
      event: "discord.gateway.disabled",
      reason: "JELLYBOT_DISABLE_DISCORD_GATEWAY",
      hostname: hostname(),
    }),
  );
} else {
  await client.login(config.discordToken);
}
