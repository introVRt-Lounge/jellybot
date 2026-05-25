import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { BotStateStore } from "./bot-state.ts";
import { fetchLatestRelease, type GitHubRelease } from "./github-releases.ts";
import { isPatchRelease } from "./semver.ts";

export type ReleaseAnnouncerConfig = {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  notificationChannelId: string;
  openaiApiKey?: string;
  gracePeriodMs: number;
  botStateDbPath: string;
};

const DEFAULT_NOTIFICATION_CHANNEL_ID = "1164501234271653918";

export class ReleaseAnnouncer {
  constructor(private readonly config: ReleaseAnnouncerConfig) {}

  async summarizeReleaseNotes(notes: string): Promise<string> {
    if (!notes.trim()) {
      return "No release notes provided.";
    }

    if (!this.config.openaiApiKey) {
      return notes;
    }

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant that summarizes GitHub release notes into a short, user-friendly announcement.",
            },
            {
              role: "user",
              content: `Summarize the following release notes:\n\n${notes}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        console.warn(`OpenAI summarize failed: ${response.status}`);
        return notes;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summary = payload.choices?.[0]?.message?.content?.trim();
      return summary || notes;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "release_announcer.summarize_failed",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return notes;
    }
  }

  async getLatestRelease(): Promise<GitHubRelease | null> {
    return fetchLatestRelease(this.config.repoOwner, this.config.repoName, this.config.githubToken);
  }

  async checkAndAnnounceNewRelease(client: Client): Promise<string | null> {
    console.info(JSON.stringify({ event: "release_announcer.check_start" }));

    const latestRelease = await this.getLatestRelease();
    if (!latestRelease) {
      console.warn(JSON.stringify({ event: "release_announcer.no_latest_release" }));
      return null;
    }

    const latestTag = latestRelease.tag_name;
    const store = new BotStateStore(this.config.botStateDbPath);
    try {
      const lastAnnouncedTag = store.getLastAnnouncedRelease();
      console.info(
        JSON.stringify({
          event: "release_announcer.compare",
          latestTag,
          lastAnnouncedTag,
        }),
      );

      if (latestTag === lastAnnouncedTag) {
        console.info(JSON.stringify({ event: "release_announcer.already_announced", tag: latestTag }));
        return latestTag;
      }

      if (isPatchRelease(latestTag)) {
        console.info(JSON.stringify({ event: "release_announcer.patch_silent", tag: latestTag }));
        store.setLastAnnouncedRelease(latestTag);
        return latestTag;
      }

      console.info(
        JSON.stringify({
          event: "release_announcer.waiting_grace",
          tag: latestTag,
          gracePeriodMs: this.config.gracePeriodMs,
        }),
      );
      await Bun.sleep(this.config.gracePeriodMs);

      const finalRelease = await this.getLatestRelease();
      if (!finalRelease) {
        console.error(JSON.stringify({ event: "release_announcer.refetch_failed", tag: latestTag }));
        return null;
      }

      const announced = await this.announceRelease(client, finalRelease);
      if (announced) {
        store.setLastAnnouncedRelease(finalRelease.tag_name);
        console.info(
          JSON.stringify({
            event: "release_announcer.announced",
            tag: finalRelease.tag_name,
          }),
        );
      }
      return finalRelease.tag_name;
    } finally {
      store.close();
    }
  }

  async announceRelease(client: Client, release: GitHubRelease): Promise<boolean> {
    if (isPatchRelease(release.tag_name)) {
      console.info(JSON.stringify({ event: "release_announcer.skip_patch_announce", tag: release.tag_name }));
      return false;
    }

    const channelId = this.config.notificationChannelId || DEFAULT_NOTIFICATION_CHANNEL_ID;
    const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased()) {
      console.error(
        JSON.stringify({
          event: "release_announcer.channel_missing",
          channelId,
        }),
      );
      return false;
    }

    const summary = await this.summarizeReleaseNotes(release.body);
    const embed = new EmbedBuilder()
      .setTitle(`New Release: ${release.name}`)
      .setDescription(summary)
      .setColor(0x00_ff_00)
      .setURL(release.html_url)
      .addFields(
        { name: "Version", value: release.tag_name, inline: true },
        { name: "Published At", value: release.published_at || "unknown", inline: true },
      );

    await (channel as TextChannel).send({ embeds: [embed] });
    return true;
  }
}

export function createReleaseAnnouncerFromConfig(config: {
  githubToken?: string;
  notificationChannelId?: string;
  openaiApiKey?: string;
  releaseRepoOwner: string;
  releaseRepoName: string;
  releaseAnnounceGraceMs: number;
  botStateDbPath: string;
}): ReleaseAnnouncer | null {
  if (!config.githubToken || !config.notificationChannelId) {
    const missing = [
      !config.githubToken ? "GITHUB_TOKEN" : null,
      !config.notificationChannelId ? "NOTIFICATION_CHANNEL_ID" : null,
    ].filter(Boolean);
    console.warn(
      JSON.stringify({
        event: "release_announcer.disabled",
        missing,
      }),
    );
    return null;
  }

  return new ReleaseAnnouncer({
    githubToken: config.githubToken,
    repoOwner: config.releaseRepoOwner,
    repoName: config.releaseRepoName,
    notificationChannelId: config.notificationChannelId,
    openaiApiKey: config.openaiApiKey,
    gracePeriodMs: config.releaseAnnounceGraceMs,
    botStateDbPath: config.botStateDbPath,
  });
}
