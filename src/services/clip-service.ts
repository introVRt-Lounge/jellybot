import { pickAudioStream, parsePreferredLanguages as parseAudioLanguages } from "../audio-track-select.ts";
import { cleanup, createClip, fileSizeMb } from "../ffmpeg.ts";
import { displayTitle } from "../display-title.ts";
import type { JellyfinClient, JellyfinItem, MediaKind } from "../jellyfin.ts";
import { formatTimestamp } from "../time.ts";
import { expectedItemType, type ClipPlan } from "./clip-request.ts";

export type ClipValidationResult =
  | { ok: true; item: JellyfinItem }
  | { ok: false; message: string };

export type ClipArtifact = {
  outputPath: string;
  attachmentName: string;
  label: string;
  summaryLine: string;
};

export function validateClipItem(
  item: JellyfinItem | null,
  plan: ClipPlan,
): ClipValidationResult {
  if (!item) {
    return { ok: false, message: "That Jellyfin item no longer exists." };
  }

  const expectedType = expectedItemType(plan.kind);
  if (item.type !== expectedType) {
    return {
      ok: false,
      message: `That item is a ${item.type}, not a ${expectedType.toLowerCase()}. Pick \`${plan.kind}\` and search again.`,
    };
  }

  if (item.runtimeTicks) {
    const runtimeSeconds = item.runtimeTicks / 10_000_000;
    if (plan.startSeconds >= runtimeSeconds) {
      return {
        ok: false,
        message: `Start time ${formatTimestamp(plan.startSeconds)} is beyond the runtime (${formatTimestamp(runtimeSeconds)}).`,
      };
    }
  }

  return { ok: true, item };
}

export function buildClipArtifact(
  item: JellyfinItem,
  plan: ClipPlan,
  interactionId: string,
  clipTempDir: string,
  formatLabel: (item: JellyfinItem, kind?: MediaKind) => string,
): ClipArtifact {
  const safeName = displayTitle(item).replace(/[^\w.-]+/g, "_").slice(0, 40);
  const outputPath = `${clipTempDir}/${interactionId}-${safeName}.mp4`;

  return {
    outputPath,
    attachmentName: `${safeName}-${formatTimestamp(plan.startSeconds).replace(/:/g, "-")}.mp4`,
    label: formatLabel(item, plan.kind),
    summaryLine: `Clip: ${formatTimestamp(plan.startSeconds)} -> ${formatTimestamp(plan.endSeconds)} (${Math.round(plan.durationSeconds)}s)`,
  };
}

export async function renderClip(params: {
  jellyfin: JellyfinClient;
  item: JellyfinItem;
  plan: ClipPlan;
  outputPath: string;
  maxClipMb: number;
  preferredAudioLanguages: string;
}): Promise<{ ok: true; audioStreamIndex?: number; audioLanguage?: string } | { ok: false; message: string }> {
  try {
    const withMedia = await params.jellyfin.getItemWithMedia(params.item.id);
    if (!withMedia) {
      return { ok: false, message: "That Jellyfin item no longer exists." };
    }

    const preferred = parseAudioLanguages(params.preferredAudioLanguages);
    const audio = pickAudioStream(withMedia.mediaSource.streams, preferred);

    await createClip({
      inputUrl: params.jellyfin.streamUrl(params.item.id, {
        mediaSourceId: withMedia.mediaSource.id,
        audioStreamIndex: audio?.index,
      }),
      startSeconds: params.plan.startSeconds,
      durationSeconds: params.plan.durationSeconds,
      outputPath: params.outputPath,
    });

    const sizeMb = await fileSizeMb(params.outputPath);
    if (sizeMb > params.maxClipMb) {
      await cleanup(params.outputPath);
      return {
        ok: false,
        message: `Clip is ${sizeMb.toFixed(1)} MB, above the ${params.maxClipMb} MB Discord limit. Try a shorter clip.`,
      };
    }

    return {
      ok: true,
      audioStreamIndex: audio?.index,
      audioLanguage: audio?.language,
    };
  } catch (error) {
    await cleanup(params.outputPath);
    return {
      ok: false,
      message: `Failed to create clip: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}
