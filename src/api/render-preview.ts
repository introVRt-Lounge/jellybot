import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { openSubtitleIndexForResolver } from "../services/clip-item-resolver.ts";
import {
  buildClipArtifact,
  renderClip,
  resolveAndValidateClipItem,
} from "../services/clip-service.ts";
import type { ClipPlan } from "../services/clip-request.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import { parseQuoteMatchToken } from "../subtitles/match-token.ts";
import { planQuoteClip } from "../services/quote-request.ts";
import type { PreviewStore } from "./preview-store.ts";

export type RenderPreviewDeps = {
  jellyfin: JellyfinClient;
  config: Pick<
    AppConfig,
    | "clipTempDir"
    | "maxClipSeconds"
    | "maxClipMb"
    | "audioLanguages"
    | "subtitleLanguages"
    | "subtitleDbPath"
    | "subtitleDefaultClipSeconds"
    | "subtitleQuotePaddingSeconds"
    | "watermarkPath"
    | "webApiMaxPreviewMb"
  >;
  previewStore: PreviewStore;
};

export type RenderPreviewSuccess = {
  ok: true;
  previewId: string;
  previewUrl: string;
  fileName: string;
  expiresAt: number;
  label: string;
};

export type RenderPreviewFailure = {
  ok: false;
  message: string;
  status: number;
};

export async function renderQuotePreview(
  deps: RenderPreviewDeps,
  input: {
    matchToken: string;
    durationRaw?: string | null;
    paddingRaw?: string | null;
    seriesFilter?: string | null;
    burnInSubtitles?: boolean;
  },
): Promise<RenderPreviewSuccess | RenderPreviewFailure> {
  const token = parseQuoteMatchToken(input.matchToken);
  if (!token) {
    return { ok: false, message: "Invalid quote match token.", status: 400 };
  }

  const index = openSubtitleIndex(deps.config.subtitleDbPath);
  let match;
  try {
    match = index.getCueMatch(token.itemId, token.startMs, token.endMs);
  } finally {
    index.close();
  }

  if (!match) {
    return {
      ok: false,
      message: "That quote match is no longer in the subtitle index.",
      status: 404,
    };
  }

  const seriesFilter =
    input.seriesFilter && input.seriesFilter.trim().length > 0
      ? input.seriesFilter.trim()
      : undefined;
  if (seriesFilter) {
    const matchSeries = match.seriesName ?? null;
    if (!matchSeries || matchSeries.toLowerCase() !== seriesFilter.toLowerCase()) {
      return {
        ok: false,
        message: `That quote is not from ${seriesFilter}.`,
        status: 400,
      };
    }
  }

  const planned = planQuoteClip({
    match,
    durationRaw: input.durationRaw,
    paddingRaw: input.paddingRaw,
    maxClipSeconds: deps.config.maxClipSeconds,
    defaultClipSeconds: deps.config.subtitleDefaultClipSeconds,
    defaultPaddingSeconds: deps.config.subtitleQuotePaddingSeconds,
  });

  if (!planned.ok) {
    return { ok: false, message: planned.message, status: 400 };
  }

  const plan: ClipPlan = {
    kind: planned.plan.kind,
    itemId: planned.plan.itemId,
    startSeconds: planned.plan.startSeconds,
    endSeconds: planned.plan.endSeconds,
    durationSeconds: planned.plan.durationSeconds,
  };

  return renderClipPlanPreview(deps, {
    plan,
    burnInSubtitles: input.burnInSubtitles ?? false,
    quoteText: planned.plan.quoteText,
  });
}

export async function renderClipPreviewRequest(
  deps: RenderPreviewDeps,
  input: {
    plan: ClipPlan;
    burnInSubtitles?: boolean;
  },
): Promise<RenderPreviewSuccess | RenderPreviewFailure> {
  return renderClipPlanPreview(deps, {
    plan: input.plan,
    burnInSubtitles: input.burnInSubtitles ?? false,
  });
}

async function renderClipPlanPreview(
  deps: RenderPreviewDeps,
  input: { plan: ClipPlan; burnInSubtitles: boolean; quoteText?: string },
): Promise<RenderPreviewSuccess | RenderPreviewFailure> {
  const previewId = randomUUID();
  const maxClipMb = Math.max(deps.config.maxClipMb, deps.config.webApiMaxPreviewMb);
  const subtitleIndex = openSubtitleIndexForResolver(deps.config.subtitleDbPath);
  const validated = await resolveAndValidateClipItem({
    jellyfin: deps.jellyfin,
    subtitleIndex,
    plan: input.plan,
  });

  if (!validated.ok) {
    return { ok: false, message: validated.message, status: 400 };
  }

  const artifact = buildClipArtifact(
    validated.item,
    input.plan,
    previewId,
    deps.config.clipTempDir,
    deps.jellyfin.formatItemLabel.bind(deps.jellyfin),
  );

  const rendered = await renderClip({
    jellyfin: deps.jellyfin,
    item: validated.item,
    plan: input.plan,
    outputPath: artifact.outputPath,
    maxClipMb,
    preferredAudioLanguages: deps.config.audioLanguages,
    burnInSubtitles: input.burnInSubtitles,
    preferredSubtitleLanguages: deps.config.subtitleLanguages,
    tempId: previewId,
    watermarkPath: deps.config.watermarkPath,
  });

  if (!rendered.ok) {
    return { ok: false, message: rendered.message, status: 400 };
  }

  const record = deps.previewStore.put({
    id: previewId,
    filePath: artifact.outputPath,
    fileName: artifact.attachmentName,
    contentType: "video/mp4",
  });

  return {
    ok: true,
    previewId,
    previewUrl: `/api/v1/previews/${previewId}`,
    fileName: artifact.attachmentName,
    expiresAt: record.expiresAt,
    label: input.quoteText ? `${artifact.label} — "${input.quoteText}"` : artifact.label,
  };
}
