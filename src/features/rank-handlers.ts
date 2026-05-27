import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type Client,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { AppConfig } from "../config.ts";
import type { FeatureStore, FeatureSuggestionRow } from "./feature-store.ts";
import { buildRankConfirmMessage } from "./leaderboard.ts";
import { refreshGuildLeaderboard } from "./leaderboard-sync.ts";

type RankSession = {
  userId: string;
  guildId: string;
  step: 1 | 2 | 3;
  picks: FeatureSuggestionRow[];
  targetPicks: number;
  expiresAt: number;
};

const sessions = new Map<string, RankSession>();
const SESSION_TTL_MS = 5 * 60_000;

export function rankTargetCount(openCount: number): number {
  return Math.min(3, Math.max(0, openCount));
}

export function shouldFinalizeRank(
  pickCount: number,
  targetPicks: number,
  remainingCount: number,
): boolean {
  return pickCount >= targetPicks || remainingCount === 0;
}

export function rankIntroMessage(openCount: number): string {
  const target = rankTargetCount(openCount);
  if (target <= 1) {
    return "Only one open suggestion — pick it as your **#1** priority.";
  }
  if (target === 2) {
    return "Pick your **#1** guild priority (then **#2** — only two suggestions open).";
  }
  return "Pick your **#1** guild priority (you'll choose **#2** and **#3** next):";
}

export function rankSelectCustomId(step: number, sessionId: string): string {
  return `feature:rank:${step}:${sessionId}`;
}

export function parseRankSelectCustomId(customId: string): { step: number; sessionId: string } | null {
  const match = /^feature:rank:(\d):([a-f0-9-]+)$/.exec(customId);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { step: Number.parseInt(match[1], 10), sessionId: match[2] };
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}

export function startRankSession(userId: string, guildId: string, openCount: number): string {
  pruneSessions();
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    userId,
    guildId,
    step: 1,
    picks: [],
    targetPicks: rankTargetCount(openCount),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessionId;
}

function buildRankSelectRow(
  step: 1 | 2 | 3,
  sessionId: string,
  options: FeatureSuggestionRow[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  if (options.length === 0) {
    throw new Error("rank select requires at least one option");
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(rankSelectCustomId(step, sessionId))
    .setPlaceholder(`Pick your #${step} priority`)
    .addOptions(
      options.slice(0, 25).map((row) => ({
        label: `#${row.githubIssueNumber} ${row.title}`.slice(0, 100),
        description: row.description.slice(0, 100),
        value: String(row.id),
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function beginRankFlow(
  store: FeatureStore,
  guildId: string,
  userId: string,
): Promise<
  | { sessionId: string; row: ActionRowBuilder<StringSelectMenuBuilder>; openCount: number }
  | { error: string }
> {
  const open = store.listOpenForGuild(guildId);
  if (open.length === 0) {
    return { error: "No open suggestions to rank yet. Use `/feature suggest` first." };
  }

  const sessionId = startRankSession(userId, guildId, open.length);
  return { sessionId, row: buildRankSelectRow(1, sessionId, open), openCount: open.length };
}

async function finalizeRankSession(
  interaction: StringSelectMenuInteraction,
  session: RankSession,
  store: FeatureStore,
  config: AppConfig,
  sessionId: string,
): Promise<void> {
  store.clearRanksForVoter(interaction.user.id);
  session.picks.forEach((pick, index) => {
    store.setRank(interaction.user.id, index + 1, pick.id);
  });
  sessions.delete(sessionId);

  await interaction.update({
    content: buildRankConfirmMessage(
      session.picks.map((pick, index) => ({
        rank: index + 1,
        title: pick.title,
        issueNumber: pick.githubIssueNumber,
      })),
    ),
    components: [],
  });

  await refreshGuildLeaderboard(interaction.client as Client, store, config, session.guildId);
}

export async function handleRankSelect(
  interaction: StringSelectMenuInteraction,
  store: FeatureStore,
  config: AppConfig,
): Promise<void> {
  const parsed = parseRankSelectCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: "Unknown rank session.", ephemeral: true });
    return;
  }

  const session = sessions.get(parsed.sessionId);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.reply({ content: "That rank session expired. Run `/feature rank` again.", ephemeral: true });
    return;
  }

  const suggestionId = Number.parseInt(interaction.values[0] ?? "", 10);
  const suggestion = store.getById(suggestionId);
  if (!suggestion) {
    await interaction.reply({ content: "That suggestion is no longer available.", ephemeral: true });
    return;
  }

  if (session.picks.some((pick) => pick.id === suggestion.id)) {
    await interaction.reply({ content: "You already picked that suggestion in this ranking.", ephemeral: true });
    return;
  }

  session.picks.push(suggestion);
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const pickedIds = new Set(session.picks.map((pick) => pick.id));
  const remaining = store.listOpenForGuild(session.guildId).filter((row) => !pickedIds.has(row.id));

  if (shouldFinalizeRank(session.picks.length, session.targetPicks, remaining.length)) {
    await finalizeRankSession(interaction, session, store, config, parsed.sessionId);
    return;
  }

  const nextStep = session.picks.length + 1;
  session.step = nextStep as 1 | 2 | 3;

  await interaction.update({
    content: `#${parsed.step} saved: **#${suggestion.githubIssueNumber} ${suggestion.title}**\nPick your **#${nextStep}** priority:`,
    components: [buildRankSelectRow(nextStep as 1 | 2 | 3, parsed.sessionId, remaining)],
  });
}

export function isFeatureRankSelect(customId: string): boolean {
  return customId.startsWith("feature:rank:");
}
