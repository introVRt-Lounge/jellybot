import { AttachmentBuilder, type Client, type Message, type TextChannel } from "discord.js";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { cleanup } from "../ffmpeg.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { openSubtitleIndexForResolver } from "../services/clip-item-resolver.ts";
import {
  buildClipArtifact,
  renderClip as defaultRenderClip,
  resolveAndValidateClipItem,
} from "../services/clip-service.ts";
import { planQuoteClip } from "../services/quote-request.ts";
import { encodeQuoteMatchToken } from "../subtitles/match-token.ts";
import { formatTimestamp } from "../time.ts";
import type { QuoteRequestMatch } from "./matcher.ts";
import type { QuoteRequestRow } from "./store.ts";

export type RenderAndPostConfig = Pick<
  AppConfig,
  | "clipTempDir"
  | "maxClipMb"
  | "maxClipSeconds"
  | "audioLanguages"
  | "subtitleLanguages"
  | "subtitleDefaultClipSeconds"
  | "subtitleQuotePaddingSeconds"
  | "subtitleDbPath"
  | "watermarkPath"
>;

export type RenderAndPostResult =
  | { posted: true; messageId: string }
  | { posted: false; reason: string };

export async function renderAndPostFulfillmentClip(input: {
  client: Pick<Client, "channels">;
  jellyfin: JellyfinClient;
  config: RenderAndPostConfig;
  request: QuoteRequestRow;
  match: QuoteRequestMatch;
  /** Override for tests; defaults to the real ffmpeg-driven renderer. */
  renderClipImpl?: typeof defaultRenderClip;
}): Promise<RenderAndPostResult> {
  const { client, jellyfin, config, request, match } = input;
  const renderClip = input.renderClipImpl ?? defaultRenderClip;

  const channel = await client.channels.fetch(request.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return { posted: false, reason: "channel_unavailable" };
  }

  const planResult = planQuoteClip({
    match: match.candidate,
    durationRaw: null,
    paddingRaw: null,
    maxClipSeconds: config.maxClipSeconds,
    defaultClipSeconds: config.subtitleDefaultClipSeconds,
    defaultPaddingSeconds: config.subtitleQuotePaddingSeconds,
  });
  if (!planResult.ok) {
    return { posted: false, reason: `plan: ${planResult.message}` };
  }

  const subtitleIndex = openSubtitleIndexForResolver(config.subtitleDbPath);
  const validated = await resolveAndValidateClipItem({
    jellyfin,
    subtitleIndex,
    plan: planResult.plan,
  });
  if (!validated.ok) {
    return { posted: false, reason: `validate: ${validated.message}` };
  }

  const tempId = `qr-${request.id}-${randomUUID().slice(0, 8)}`;
  const artifact = buildClipArtifact(
    validated.item,
    planResult.plan,
    tempId,
    config.clipTempDir,
    jellyfin.formatItemLabel.bind(jellyfin),
  );

  const rendered = await renderClip({
    jellyfin,
    item: validated.item,
    plan: planResult.plan,
    outputPath: artifact.outputPath,
    maxClipMb: config.maxClipMb,
    preferredAudioLanguages: config.audioLanguages,
    preferredSubtitleLanguages: config.subtitleLanguages,
    burnInSubtitles: false,
    tempId,
    watermarkPath: config.watermarkPath,
  });

  if (!rendered.ok) {
    return { posted: false, reason: `render: ${rendered.message}` };
  }

  try {
    const matchToken = encodeQuoteMatchToken({
      itemId: match.candidate.itemId,
      startMs: match.candidate.startMs,
      endMs: match.candidate.endMs,
    });
    const cue = match.candidate.text.replace(/\s+/g, " ").trim();
    const heading =
      match.confidence === "high"
        ? "your wish is granted"
        : "your wish is granted (best guess - might not be exactly the line)";
    const content = [
      `<@${request.requesterDiscordId}> ${heading}`,
      `> ${truncate(cue, 240)}`,
      `-# **${artifact.label}** @ ${formatTimestamp(planResult.plan.cueStartSeconds)} - want a different range? \`/quote match:\` and pick this line, or paste this token:`,
      "```",
      matchToken,
      "```",
    ]
      .join("\n")
      .slice(0, 2000);

    const attachment = new AttachmentBuilder(artifact.outputPath, {
      name: artifact.attachmentName,
    });

    const message: Message = await (channel as TextChannel).send({
      content,
      files: [attachment],
      allowedMentions: { users: [request.requesterDiscordId] },
    });

    return { posted: true, messageId: message.id };
  } finally {
    await cleanup(artifact.outputPath).catch(() => undefined);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
