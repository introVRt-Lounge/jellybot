import { dirname } from "node:path";
import { pickAudioStream, parsePreferredLanguages as parseAudioLanguages } from "../audio-track-select.ts";
import {
  cleanup,
  createClip,
  fileSizeMb,
  probeRenderedClipStats,
  validateRenderedClip,
} from "../ffmpeg.ts";
import { displayTitle } from "../display-title.ts";
import type { JellyfinClient, JellyfinItem, MediaKind } from "../jellyfin.ts";
import { formatTimestamp } from "../time.ts";
import { prepareClipSubtitleFile } from "../subtitles/burn-in.ts";
import type { SubtitleIndex } from "../subtitles/index-db.ts";
import { expectedItemType, type ClipPlan } from "./clip-request.ts";
import { resolveClipItem } from "./clip-item-resolver.ts";

export type ClipValidationResult =
  | { ok: true; item: JellyfinItem }
  | { ok: false; message: string };

export type ClipArtifact = {
  outputPath: string;
  attachmentName: string;
  label: string;
  summaryLine: string;
};

/**
 * Resolve a Jellyfin item for the clip plan and validate it against the
 * plan (kind / runtime). When the original item id is gone (Jellyfin
 * reissued an id after a file replace), `resolveClipItem` falls back to
 * looking the item up by stable subtitle-index metadata. Issue #118.
 */
export async function resolveAndValidateClipItem(deps: {
  jellyfin: JellyfinClient;
  subtitleIndex: SubtitleIndex | null;
  plan: ClipPlan;
}): Promise<ClipValidationResult> {
  const resolved = await resolveClipItem({
    jellyfin: deps.jellyfin,
    subtitleIndex: deps.subtitleIndex,
    itemId: deps.plan.itemId,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      message:
        "That Jellyfin item no longer exists, and I couldn't relocate it from the indexed metadata. Try `/quote` or `/clip` again - the next index pass will catch up.",
    };
  }

  return validateClipItem(resolved.item, deps.plan);
}

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
  burnInSubtitles?: boolean;
  preferredSubtitleLanguages?: string;
  tempId: string;
  watermarkPath?: string;
}): Promise<
  | { ok: true; audioStreamIndex?: number; audioLanguage?: string; subtitlesBurnedIn: boolean }
  | { ok: false; message: string }
> {
  let subtitlePath: string | undefined;

  try {
    const withMedia = await params.jellyfin.getItemWithMedia(params.item.id);
    if (!withMedia) {
      return { ok: false, message: "That Jellyfin item no longer exists." };
    }

    const preferred = parseAudioLanguages(params.preferredAudioLanguages);
    const audio = pickAudioStream(withMedia.mediaSource.streams, preferred);

    if (params.burnInSubtitles) {
      subtitlePath = `${dirname(params.outputPath)}/${params.tempId}-subs.srt`;
      const prepared = await prepareClipSubtitleFile({
        jellyfin: params.jellyfin,
        itemId: params.item.id,
        mediaSourceId: withMedia.mediaSource.id,
        streams: withMedia.mediaSource.streams,
        preferredLanguages: params.preferredSubtitleLanguages ?? params.preferredAudioLanguages,
        clipStartSeconds: params.plan.startSeconds,
        clipEndSeconds: params.plan.endSeconds,
        outputPath: subtitlePath,
      });

      if (!prepared.ok) {
        return prepared;
      }
    }

    await createClip({
      inputUrl: params.jellyfin.streamUrl(params.item.id, {
        mediaSourceId: withMedia.mediaSource.id,
        audioStreamIndex: audio?.index,
      }),
      startSeconds: params.plan.startSeconds,
      durationSeconds: params.plan.durationSeconds,
      outputPath: params.outputPath,
      audioStreamIndex: audio?.index,
      subtitlePath,
      watermarkPath: params.watermarkPath,
    });

    const sizeMb = await fileSizeMb(params.outputPath);
    if (sizeMb > params.maxClipMb) {
      await cleanup(params.outputPath);
      return {
        ok: false,
        message: `Clip is ${sizeMb.toFixed(1)} MB, above the ${params.maxClipMb} MB Discord limit. Try a shorter clip.`,
      };
    }

    // ffmpeg cheerfully exits 0 even when the matroska demuxer hits "File
    // ended prematurely" mid-seek and writes an mp4 with zero packets. Catch
    // those before we ship them to Discord with a "your wish is granted"
    // message attached.
    let stats;
    try {
      stats = await probeRenderedClipStats(params.outputPath);
    } catch (error) {
      await cleanup(params.outputPath);
      return {
        ok: false,
        message: `Failed to validate clip output: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    const validation = validateRenderedClip(stats);
    if (!validation.ok) {
      console.warn(
        JSON.stringify({
          event: "clip.empty_output",
          itemId: params.item.id,
          startSeconds: params.plan.startSeconds,
          durationSeconds: params.plan.durationSeconds,
          reason: validation.reason,
          sizeBytes: validation.stats.sizeBytes,
          videoFrames: validation.stats.videoFrames,
          audioFrames: validation.stats.audioFrames,
        }),
      );
      await cleanup(params.outputPath);
      const detail =
        validation.reason === "tiny_file"
          ? `output was ${validation.stats.sizeBytes} bytes`
          : `no video frames decoded`;
      return {
        ok: false,
        message: `Render produced an empty clip (${detail}). The source file may be corrupt or not seekable at that timestamp.`,
      };
    }

    return {
      ok: true,
      audioStreamIndex: audio?.index,
      audioLanguage: audio?.language,
      subtitlesBurnedIn: Boolean(subtitlePath),
    };
  } catch (error) {
    await cleanup(params.outputPath);
    return {
      ok: false,
      message: `Failed to create clip: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  } finally {
    if (subtitlePath) {
      await cleanup(subtitlePath);
    }
  }
}
