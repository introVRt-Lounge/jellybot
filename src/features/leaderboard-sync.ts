import type { Client, TextChannel } from "discord.js";
import type { AppConfig } from "../config.ts";
import type { FeatureStore } from "./feature-store.ts";
import { buildLeaderboardEmbed, buildSuggestionCardEmbed } from "./leaderboard.ts";

export async function refreshGuildLeaderboard(
  client: Client,
  store: FeatureStore,
  config: AppConfig,
  guildId: string,
): Promise<void> {
  if (!config.featureSuggestionsChannelId) {
    return;
  }

  const channel = await client.channels.fetch(config.featureSuggestionsChannelId);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const scores = store.getScoresForGuild(guildId);
  const embed = buildLeaderboardEmbed(scores, config.releaseRepoOwner, config.releaseRepoName);

  const existingId = store.getLeaderboardMessageId(guildId);
  if (existingId) {
    const existing = await (channel as TextChannel).messages.fetch(existingId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  }

  const message = await (channel as TextChannel).send({ embeds: [embed] });
  store.setLeaderboardMessageId(guildId, message.id);
}

export async function postSuggestionCard(
  client: Client,
  config: AppConfig,
  store: FeatureStore,
  guildId: string,
  suggestionId: number,
): Promise<void> {
  if (!config.featureSuggestionsChannelId) {
    return;
  }

  const suggestion = store.getById(suggestionId);
  if (!suggestion) {
    return;
  }

  const channel = await client.channels.fetch(config.featureSuggestionsChannelId);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const scores = store.getScoresForGuild(guildId);
  const points = scores.find((row) => row.suggestionId === suggestionId)?.points ?? 0;
  const embed = buildSuggestionCardEmbed(
    suggestion,
    config.releaseRepoOwner,
    config.releaseRepoName,
    points,
  );

  const message = await (channel as TextChannel).send({ embeds: [embed] });
  store.setChannelMessageId(suggestionId, message.id);
  await refreshGuildLeaderboard(client, store, config, guildId);
}
