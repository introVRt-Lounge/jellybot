import { EmbedBuilder } from "discord.js";
import type { FeatureScoreRow, FeatureSuggestionRow } from "./feature-store.ts";

export function buildSuggestionCardEmbed(
  suggestion: FeatureSuggestionRow,
  repoOwner: string,
  repoName: string,
  points: number,
): EmbedBuilder {
  const issueUrl = `https://github.com/${repoOwner}/${repoName}/issues/${suggestion.githubIssueNumber}`;
  return new EmbedBuilder()
    .setTitle(`💡 #${suggestion.githubIssueNumber} · ${suggestion.title}`)
    .setDescription(suggestion.description.slice(0, 500))
    .setColor(0x58_65_f2)
    .setURL(issueUrl)
    .addFields(
      { name: "Suggested by", value: suggestion.suggesterName, inline: true },
      { name: "Guild priority pts", value: String(points), inline: true },
      { name: "Rank it", value: "Use `/feature rank` (pick your top 3)", inline: false },
    );
}

export function buildLeaderboardEmbed(
  scores: FeatureScoreRow[],
  repoOwner: string,
  repoName: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Guild feature priority")
    .setColor(0xfee_75_c)
    .setDescription(
      "Rank with `/feature rank` — pick **#1, #2, #3** (3/2/1 points). Suggest with `/feature suggest`.",
    );

  if (scores.length === 0) {
    embed.addFields({ name: "Open suggestions", value: "_None yet — be the first with `/feature suggest`._" });
    return embed;
  }

  const lines = scores.slice(0, 15).map((row, index) => {
    const url = `https://github.com/${repoOwner}/${repoName}/issues/${row.githubIssueNumber}`;
    return `${index + 1}. [#${row.githubIssueNumber} ${row.title}](${url}) — **${row.points}** pts (${row.voterCount} voters)`;
  });

  embed.addFields({ name: "Leaderboard", value: lines.join("\n").slice(0, 1024) });
  return embed;
}

export function buildRankConfirmMessage(picks: Array<{ rank: number; title: string; issueNumber: number }>): string {
  const lines = picks.map((pick) => `${pick.rank}. #${pick.issueNumber} ${pick.title}`);
  return `Saved your priorities:\n${lines.join("\n")}\n\nYou can run \`/feature rank\` again anytime to change them.`;
}
