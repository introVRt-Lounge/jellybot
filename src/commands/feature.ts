import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Client } from "discord.js";
import type { AppConfig } from "../config.ts";
import { FeatureStore } from "../features/feature-store.ts";
import { blessFeatureIssueForTriage, createFeatureSuggestionIssue } from "../features/github-issues.ts";
import { postSuggestionCard } from "../features/leaderboard-sync.ts";
import { beginRankFlow, isFeatureRankSelect } from "../features/rank-handlers.ts";
import { evaluateSuggestionScope, suggestionIssueTitle } from "../features/scope-gate.ts";

export { isFeatureRankSelect };

let featureStore: FeatureStore | null = null;

function storeFor(config: AppConfig): FeatureStore {
  if (!featureStore) {
    featureStore = new FeatureStore(config.botStateDbPath);
  }
  return featureStore;
}

export const featureCommand = new SlashCommandBuilder()
  .setName("feature")
  .setDescription("Suggest and rank jellybot features for the guild.")
  .addSubcommand((sub) =>
    sub
      .setName("suggest")
      .setDescription("Propose a bot capability (scope-checked, then ranked by the guild)")
      .addStringOption((option) =>
        option.setName("description").setDescription("What should the bot do?").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("rank").setDescription("Pick your top 3 feature priorities (3/2/1 points)"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("choose")
      .setDescription("Bless a suggestion for Cursor triage (maintainer)")
      .addIntegerOption((option) =>
        option
          .setName("issue")
          .setDescription("GitHub issue number to build")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

export function isFeatureTriageUser(config: AppConfig, discordUserId: string): boolean {
  return config.featureTriageDiscordUserIds.includes(discordUserId);
}

export async function handleFeatureAutocomplete(
  interaction: AutocompleteInteraction,
  config: AppConfig,
): Promise<void> {
  if (interaction.options.getSubcommand() !== "choose") {
    await interaction.respond([]);
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }

  const store = storeFor(config);
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();
  const open = store.listOpenForGuild(guildId, 25);
  const choices = open
    .filter(
      (row) =>
        !query ||
        row.title.toLowerCase().includes(query) ||
        String(row.githubIssueNumber).includes(query),
    )
    .slice(0, 25)
    .map((row) => ({
      name: `#${row.githubIssueNumber} ${row.title}`.slice(0, 100),
      value: row.githubIssueNumber,
    }));

  await interaction.respond(choices);
}

export async function handleFeatureCommand(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  client: Client,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Use feature commands inside a guild.", ephemeral: true });
    return;
  }

  if (!config.featureSuggestionsChannelId) {
    await interaction.reply({
      content: "Feature suggestions are not configured on this bot (`FEATURE_SUGGESTIONS_CHANNEL_ID`).",
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const store = storeFor(config);

  if (sub === "suggest") {
    await handleFeatureSuggest(interaction, config, client, store, guildId);
    return;
  }

  if (sub === "rank") {
    await handleFeatureRank(interaction, store, guildId);
    return;
  }

  if (sub === "choose") {
    await handleFeatureChoose(interaction, config, store, guildId);
  }
}

async function handleFeatureSuggest(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  client: Client,
  store: FeatureStore,
  guildId: string,
): Promise<void> {
  const description = interaction.options.getString("description", true).trim();
  await interaction.deferReply({ ephemeral: true });

  const gate = await evaluateSuggestionScope(description, config.openaiApiKey);
  if (!gate.ok) {
    await interaction.editReply(gate.reason);
    return;
  }

  if (!config.githubToken) {
    await interaction.editReply("GitHub integration is not configured (`GITHUB_TOKEN` missing).");
    return;
  }

  const title = suggestionIssueTitle(description);
  const created = await createFeatureSuggestionIssue({
    repoOwner: config.releaseRepoOwner,
    repoName: config.releaseRepoName,
    githubToken: config.githubToken,
    title,
    body: gate.issueBody,
    reporterDiscordId: interaction.user.id,
    reporterDiscordName: interaction.user.displayName || interaction.user.username,
  });

  const row = store.insertSuggestion({
    githubIssueNumber: created.number,
    title,
    description,
    suggesterDiscordId: interaction.user.id,
    suggesterName: interaction.user.displayName || interaction.user.username,
    guildId,
    scopeSummary: gate.summary,
  });

  await postSuggestionCard(client, config, store, guildId, row.id);

  await interaction.editReply(
    `Scope check passed. Created ${created.htmlUrl} and posted to the suggestions channel. Rank it with \`/feature rank\`.`,
  );
}

async function handleFeatureRank(
  interaction: ChatInputCommandInteraction,
  store: FeatureStore,
  guildId: string,
): Promise<void> {
  const flow = await beginRankFlow(store, guildId, interaction.user.id);
  if ("error" in flow) {
    await interaction.reply({ content: flow.error, ephemeral: true });
    return;
  }

  await interaction.reply({
    content: "Pick your **#1** guild priority (you'll choose #2 and #3 next):",
    components: [flow.row],
    ephemeral: true,
  });
}

async function handleFeatureChoose(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  store: FeatureStore,
  guildId: string,
): Promise<void> {
  if (!isFeatureTriageUser(config, interaction.user.id)) {
    await interaction.reply({ content: "Only feature triage maintainers can bless suggestions.", ephemeral: true });
    return;
  }

  const issueNumber = interaction.options.getInteger("issue", true);
  const suggestion = store.getByGithubIssueNumber(issueNumber);
  if (!suggestion || suggestion.guildId !== guildId) {
    await interaction.reply({
      content: `Issue #${issueNumber} is not an open guild suggestion here.`,
      ephemeral: true,
    });
    return;
  }

  if (!config.githubToken) {
    await interaction.reply({ content: "GitHub integration is not configured (`GITHUB_TOKEN` missing).", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  await blessFeatureIssueForTriage({
    repoOwner: config.releaseRepoOwner,
    repoName: config.releaseRepoName,
    githubToken: config.githubToken,
    issueNumber,
  });

  store.setStatus(suggestion.id, "building");

  await interaction.editReply(
    `Blessed **#${issueNumber}** — added \`ai-safe\` + \`discord-triage-blessed\` on GitHub. Cursor triage should start shortly.`,
  );
}
