import type { Client, TextChannel } from "discord.js";
import type { AppConfig } from "../config.ts";
import type { PipelineInspection } from "./pipeline-tracker.ts";

export async function notifyPipelineOpsInBotspam(
  client: Client,
  config: AppConfig,
  inspection: PipelineInspection,
): Promise<void> {
  const channelId = config.discordBotspamChannelId;
  if (!channelId) {
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    console.warn(
      JSON.stringify({
        event: "feature.pipeline.botspam_skip",
        reason: "channel_not_text",
        channelId,
      }),
    );
    return;
  }

  const blocker = inspection.blocker ?? "unknown";
  const content =
    `Pipeline **#${inspection.issueNumber}** — **${inspection.stageLabel}**\n` +
    `${blocker}\n` +
    `${inspection.issueUrl}`;

  await (channel as TextChannel).send({ content: content.slice(0, 2000) });
}
