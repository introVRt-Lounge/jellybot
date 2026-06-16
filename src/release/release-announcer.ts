import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { BotStateStore } from "./bot-state.ts";
import { fetchLatestRelease, listReleases, type GitHubRelease, type ListReleasesResult } from "./github-releases.ts";
import { buildCommunityCreditsForRelease } from "./build-community-credits.ts";
import { buildFeatureCreditsForRelease } from "./release-feature-credits.ts";
import { compareReleaseTags, isPatchRelease } from "./semver.ts";

export type ReleaseAnnouncerConfig = {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  notificationChannelId: string;
  openaiApiKey?: string;
  gracePeriodMs: number;
  botStateDbPath: string;
};

const DEFAULT_NOTIFICATION_CHANNEL_ID = "1159798255295660103";

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

  /**
   * Walk releases newest-first across pages, stopping when `stopTag` is
   * encountered or the page cap is hit. Issue #158: a single-page fetch
   * silently leapfrogged feats whose tags fell off the first page when
   * the announcer was broken across many releases.
   *
   * `maxPages: 50` × `perPage: 100` = 5000 releases of headroom. At this
   * repo's cadence (~1 release/day), that's ~13 years - effectively
   * infinite. If the cap is somehow still hit, the announcer refuses to
   * stamp or post and surfaces a CRITICAL log line for operator triage,
   * because attempting to advance past an unseen window risks silently
   * leapfrogging feats (the original bug).
   */
  async listReleases(stopTag?: string): Promise<ListReleasesResult> {
    return listReleases(this.config.repoOwner, this.config.repoName, this.config.githubToken, {
      stopTag,
      maxPages: 50,
      perPage: 100,
    });
  }

  async getFeatureCredits(releaseTag: string): Promise<string | null> {
    return buildFeatureCreditsForRelease({
      repoOwner: this.config.repoOwner,
      repoName: this.config.repoName,
      githubToken: this.config.githubToken,
      currentTag: releaseTag,
    });
  }

  async getCommunityCredits(releaseTag: string): Promise<string | null> {
    return buildCommunityCreditsForRelease({
      repoOwner: this.config.repoOwner,
      repoName: this.config.repoName,
      githubToken: this.config.githubToken,
      currentTag: releaseTag,
    });
  }

  /**
   * Walk every release published since the last successfully announced
   * tag and decide whether to post. Issue #156: prior logic only inspected
   * the latest release, so a feat that landed in a window followed by a
   * patch was permanently leapfrogged - the patch-silent branch would mark
   * the patch announced and skip the feat between them.
   *
   * New behaviour:
   *  - Fetch the most recent N releases (drafts/prereleases excluded).
   *  - Sort by semver ascending; identify the gap above `lastAnnouncedTag`.
   *  - If the gap is empty, no-op.
   *  - If the gap contains only patches, mark the latest as announced
   *    silently (preserves the original "patches are silent" intent).
   *  - Otherwise, announce the highest non-patch tag in the gap and mark
   *    every walked tag as announced. Multiple feats in one gap collapse
   *    to a single announcement (the latest); rare and out of scope.
   */
  async checkAndAnnounceNewRelease(client: Client): Promise<string | null> {
    console.info(JSON.stringify({ event: "release_announcer.check_start" }));

    const store = new BotStateStore(this.config.botStateDbPath);
    try {
      const lastAnnouncedTag = store.getLastAnnouncedRelease();

      let listing: ListReleasesResult;
      try {
        listing = await this.listReleases(lastAnnouncedTag ?? undefined);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "release_announcer.list_failed",
            error: error instanceof Error ? error.message : "unknown error",
          }),
        );
        return null;
      }

      const releases = listing.releases;
      if (releases.length === 0) {
        console.warn(JSON.stringify({ event: "release_announcer.no_releases" }));
        return null;
      }

      const sorted = [...releases].sort((a, b) => compareReleaseTags(a.tag_name, b.tag_name));
      const oldestVisibleTag = sorted[0]!.tag_name;
      const latestTag = sorted[sorted.length - 1]!.tag_name;

      const gap = lastAnnouncedTag
        ? sorted.filter((r) => compareReleaseTags(r.tag_name, lastAnnouncedTag) > 0)
        : sorted.slice(); // first run: walk everything visible

      console.info(
        JSON.stringify({
          event: "release_announcer.compare",
          latestTag,
          lastAnnouncedTag,
          gapSize: gap.length,
          pagesExhausted: listing.exhausted,
          foundStopTag: listing.foundStopTag,
          oldestVisibleTag,
        }),
      );

      // Issue #158: when listReleases walked the full page cap (5000
      // releases) without seeing lastAnnouncedTag, the gap is larger
      // than our window. We cannot stamp `latestTag` (would silently
      // leapfrog unseen feats - the original bug) and we cannot stamp
      // `oldestVisibleTag` either (would re-announce the same visible
      // non-patch on the next run). Bail and surface CRITICAL for
      // operator triage; they can either trim the tag set or manually
      // advance the bot-state stamp.
      if (listing.exhausted && lastAnnouncedTag) {
        console.error(
          JSON.stringify({
            event: "release_announcer.list_exhausted",
            level: "CRITICAL",
            lastAnnouncedTag,
            oldestVisibleTag,
            latestTag,
            note: "stopTag not found within 5000-release window; refusing to post or stamp. Operator action required.",
          }),
        );
        return null;
      }

      if (gap.length === 0) {
        console.info(JSON.stringify({ event: "release_announcer.already_announced", tag: latestTag }));
        return latestTag;
      }

      const nonPatches = gap.filter((r) => !isPatchRelease(r.tag_name));
      const toAnnounce = nonPatches[nonPatches.length - 1] ?? null;

      if (!toAnnounce) {
        console.info(
          JSON.stringify({
            event: "release_announcer.patch_silent",
            tag: latestTag,
            gapTags: gap.map((r) => r.tag_name),
          }),
        );
        store.setLastAnnouncedRelease(latestTag);
        return latestTag;
      }

      console.info(
        JSON.stringify({
          event: "release_announcer.gap_walk",
          lastAnnouncedTag,
          latestTag,
          gapTags: gap.map((r) => r.tag_name),
          announcingTag: toAnnounce.tag_name,
          gracePeriodMs: this.config.gracePeriodMs,
        }),
      );

      if (this.config.gracePeriodMs > 0) {
        await Bun.sleep(this.config.gracePeriodMs);
      }

      const announced = await this.announceRelease(client, toAnnounce, { allowPatch: false });
      if (announced) {
        store.setLastAnnouncedRelease(latestTag);
        console.info(
          JSON.stringify({
            event: "release_announcer.announced",
            tag: toAnnounce.tag_name,
            markedAs: latestTag,
          }),
        );
      }
      return latestTag;
    } finally {
      store.close();
    }
  }

  async announceRelease(
    client: Client,
    release: GitHubRelease,
    options?: { allowPatch?: boolean },
  ): Promise<boolean> {
    if (isPatchRelease(release.tag_name) && !options?.allowPatch) {
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
    let featureCredits: string | null = null;
    try {
      featureCredits = await this.getFeatureCredits(release.tag_name);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "release_announcer.feature_credits_failed",
          tag: release.tag_name,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }

    let communityCredits: string | null = null;
    try {
      communityCredits = await this.getCommunityCredits(release.tag_name);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "release_announcer.community_credits_failed",
          tag: release.tag_name,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }

    const embed = new EmbedBuilder()
      .setTitle(`New Release: ${release.name}`)
      .setDescription(summary)
      .setColor(0x00_ff_00)
      .setURL(release.html_url)
      .addFields(
        { name: "Version", value: release.tag_name, inline: true },
        { name: "Published At", value: release.published_at || "unknown", inline: true },
      );

    if (featureCredits) {
      embed.addFields({ name: "Feature credits", value: featureCredits.slice(0, 1024) });
    }

    if (communityCredits) {
      embed.addFields({ name: "Community thanks", value: communityCredits.slice(0, 1024) });
    }

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
