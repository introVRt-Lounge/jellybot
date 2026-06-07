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
import { clipCommand, handleClipAutocomplete, handleClipCommand } from "./commands/clip.ts";
import {
  featureCommand,
  handleFeatureAutocomplete,
  handleFeatureCommand,
  isFeatureRankSelect,
} from "./commands/feature.ts";
import { handleQuoteAutocomplete, handleQuoteCommand, quoteCommand } from "./commands/quote.ts";
import { handleQuoteRequestModalSubmit } from "./quote-requests/handle-modal.ts";
import {
  handleQuoteRequestMediaTypeSelect,
  isQuoteRequestMediaTypeSelect,
} from "./quote-requests/handle-select.ts";
import { isQuoteRequestModal } from "./quote-requests/modal.ts";
import {
  handleSubcoverageAutocomplete,
  handleSubcoverageCommand,
  subcoverageCommand,
} from "./commands/subcoverage.ts";
import {
  buildSupercutCommand,
  handleSupercutAutocomplete,
  handleSupercutCommand,
} from "./commands/supercut.ts";
import { startQuoteRequestReconcileLoop } from "./quote-requests/reconciler.ts";
import { loadConfig } from "./config.ts";
import {
  createRestCommandRegistry,
  ensureNoStaleGlobalCommands,
  planCommandSync,
} from "./discord/command-sync.ts";
import { autoSyncSlashCommands } from "./discord/command-sync-auto.ts";
import { BotStateStore } from "./release/bot-state.ts";
import { startHealthServer, type HealthState } from "./health.ts";
import { JellyfinClient } from "./jellyfin.ts";
import { indexSubtitles } from "./subtitles/indexer.ts";
import { openSubtitleIndex } from "./subtitles/index-db.ts";
import { parsePreferredLanguages } from "./subtitles/track-select.ts";
import { WebhookDispatcher } from "./webhooks/dispatch.ts";
import { createReleaseAnnouncerFromConfig } from "./release/release-announcer.ts";
import { looksLikeReleaseTag } from "./release/semver.ts";
import { isBenignAutocompleteError } from "./autocomplete-guard.ts";
import { handleRankSelect } from "./features/rank-handlers.ts";
import { FeatureStore } from "./features/feature-store.ts";
import { startFeaturePipelineReconcileLoop } from "./features/pipeline-reconcile.ts";

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

const webhookDispatcher = config.webhookSharedSecret
  ? new WebhookDispatcher({
      jellyfin,
      config: {
        subtitleDbPath: config.subtitleDbPath,
        preferredLanguages: parsePreferredLanguages(config.subtitleLanguages),
        debounceMs: config.webhookDebounceMs,
        pollMaxAttempts: config.webhookPollMaxAttempts,
        pollIntervalMs: config.webhookPollIntervalMs,
        postRefreshSettleMs: config.webhookPostRefreshSettleMs,
      },
    })
  : null;

startHealthServer(
  config.healthPort,
  config.appVersion,
  () => {
    refreshSubtitleHealth();
    return healthState;
  },
  webhookDispatcher
    ? {
        webhooks: {
          config: { sharedSecret: config.webhookSharedSecret ?? "" },
          dispatcher: webhookDispatcher,
        },
      }
    : {},
);
console.info(`Health server listening on :${config.healthPort}/healthz`);
if (webhookDispatcher) {
  console.info(
    JSON.stringify({
      event: "webhook.server_ready",
      paths: ["/hooks/radarr", "/hooks/sonarr", "/hooks/bazarr"],
      debounceMs: config.webhookDebounceMs,
    }),
  );
} else {
  console.info(
    JSON.stringify({
      event: "webhook.disabled",
      reason: "WEBHOOK_SHARED_SECRET not set",
    }),
  );
}

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
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    const registry = createRestCommandRegistry(rest, config.discordClientId);

    if (commandSyncPlan.mode === "guild") {
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
    }

    const body = [
      clipCommand.toJSON(),
      quoteCommand.toJSON(),
      featureCommand.toJSON(),
      subcoverageCommand.toJSON(),
      buildSupercutCommand(config.supercutMaxClips).toJSON(),
    ];
    const syncStateStore = new BotStateStore(config.botStateDbPath);
    try {
      const outcome = await autoSyncSlashCommands({
        registry,
        body,
        plan: commandSyncPlan,
        store: syncStateStore,
      });
      if (outcome.kind === "synced") {
        console.info(
          JSON.stringify({
            event: "discord.commands.synced",
            scopeKey: outcome.scopeKey,
            bodyHash: outcome.bodyHash,
            guildIds: outcome.guildIds,
            globalsCleared: outcome.globalsCleared,
            commandCount: body.length,
          }),
        );
      } else if (outcome.kind === "noop") {
        console.info(
          JSON.stringify({
            event: "discord.commands.already_synced",
            scopeKey: outcome.scopeKey,
            bodyHash: outcome.bodyHash,
          }),
        );
      } else if (outcome.kind === "refused_empty_body") {
        console.error(
          JSON.stringify({
            event: "discord.commands.refused_empty_body",
            scopeKey: outcome.scopeKey,
            reason: "body length is zero - refusing to wipe registered commands",
          }),
        );
      } else {
        console.warn(
          JSON.stringify({
            event: "discord.commands.skipped_no_scope",
            mode: commandSyncPlan.mode,
          }),
        );
      }
    } finally {
      syncStateStore.close();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "discord.commands.sync_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
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

  if (config.githubToken && config.featureSuggestionsChannelId) {
    const featureStore = new FeatureStore(config.botStateDbPath);
    startFeaturePipelineReconcileLoop(client, config, featureStore);
  }

  startQuoteRequestReconcileLoop({ client, config, jellyfin });
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
      return;
    }

    if (interaction.commandName === "feature") {
      try {
        await handleFeatureAutocomplete(interaction, config);
      } catch (error) {
        console.error("Feature autocomplete error:", error);
        if (!interaction.responded) {
          await interaction.respond([]).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.commandName === "subcoverage") {
      try {
        await handleSubcoverageAutocomplete(interaction, jellyfin);
      } catch (error) {
        if (!isBenignAutocompleteError(error)) {
          console.error("Subcoverage autocomplete error:", error);
        }
        if (!interaction.responded) {
          await interaction.respond([]).catch(() => undefined);
        }
      }
      return;
    }

    if (interaction.commandName === "supercut") {
      try {
        await handleSupercutAutocomplete(interaction, config);
      } catch (error) {
        if (!isBenignAutocompleteError(error)) {
          console.error("Supercut autocomplete error:", error);
        }
        if (!interaction.responded) {
          await interaction.respond([]).catch(() => undefined);
        }
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() && isQuoteRequestMediaTypeSelect(interaction)) {
    try {
      await handleQuoteRequestMediaTypeSelect(interaction);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "quote_request.media_type_select_error",
          userId: interaction.user.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "Something went wrong opening that form.", ephemeral: true })
          .catch(() => undefined);
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() && isFeatureRankSelect(interaction.customId)) {
    try {
      const { FeatureStore } = await import("./features/feature-store.ts");
      const store = new FeatureStore(config.botStateDbPath);
      try {
        await handleRankSelect(interaction, store, config);
      } finally {
        store.close();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "feature.rank.error",
          userId: interaction.user.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong while saving your rank.", ephemeral: true }).catch(() => undefined);
      } else {
        await interaction
          .editReply({ content: "Something went wrong while saving your rank.", components: [] })
          .catch(() => undefined);
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

  if (interaction.isModalSubmit() && isQuoteRequestModal(interaction)) {
    try {
      await handleQuoteRequestModalSubmit(interaction, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "quote_request.modal_dispatch_error",
          userId: interaction.user.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "Something went wrong handling that request.", ephemeral: true })
          .catch(() => undefined);
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
    return;
  }

  if (interaction.commandName === "subcoverage") {
    try {
      await handleSubcoverageCommand(interaction, jellyfin, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "subcoverage.error",
          command: "subcoverage",
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
    return;
  }

  if (interaction.commandName === "feature") {
    try {
      await handleFeatureCommand(interaction, config, client);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "feature.error",
          command: "feature",
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
    return;
  }

  if (interaction.commandName === "supercut") {
    try {
      await handleSupercutCommand(interaction, jellyfin, config);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "supercut.error",
          command: "supercut",
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
