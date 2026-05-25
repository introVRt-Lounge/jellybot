import { writeFile } from "node:fs/promises";
import type { JellyfinClient } from "../jellyfin.ts";
import { parseSubtitleContent, type ParsedCue } from "./parse.ts";
import { pickSubtitleStream, parsePreferredLanguages, type SubtitleStreamCandidate } from "./track-select.ts";

export function shiftCuesForClip(cues: ParsedCue[], clipStartSeconds: number, clipEndSeconds: number): ParsedCue[] {
  return cues
    .filter((cue) => cue.endSeconds > clipStartSeconds && cue.startSeconds < clipEndSeconds)
    .map((cue) => ({
      startSeconds: Math.max(0, cue.startSeconds - clipStartSeconds),
      endSeconds: Math.min(clipEndSeconds - clipStartSeconds, cue.endSeconds - clipStartSeconds),
      text: cue.text,
    }))
    .filter((cue) => cue.endSeconds > cue.startSeconds && cue.text.trim().length > 0);
}

export function formatSrtTimestamp(seconds: number): string {
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const millis = totalMillis % 1000;
  const totalSeconds = Math.floor(totalMillis / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function renderSrt(cues: ParsedCue[]): string {
  return cues
    .map((cue, index) => {
      const text = cue.text.replace(/\r?\n/g, "\n");
      return `${index + 1}\n${formatSrtTimestamp(cue.startSeconds)} --> ${formatSrtTimestamp(cue.endSeconds)}\n${text}\n`;
    })
    .join("\n");
}

export async function writeSrtFile(cues: ParsedCue[], outputPath: string): Promise<void> {
  await writeFile(outputPath, `${renderSrt(cues)}\n`, "utf8");
}

export async function prepareClipSubtitleFile(params: {
  jellyfin: JellyfinClient;
  itemId: string;
  mediaSourceId: string;
  streams: SubtitleStreamCandidate[];
  preferredLanguages: string;
  clipStartSeconds: number;
  clipEndSeconds: number;
  outputPath: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const preferred = parsePreferredLanguages(params.preferredLanguages);
  const stream = pickSubtitleStream(params.streams, preferred);
  if (!stream) {
    return { ok: false, message: "No subtitle track is available for burn-in on this item." };
  }

  let raw: { content: string; format: "vtt" | "srt" };
  try {
    raw = await params.jellyfin.fetchSubtitleText(
      params.itemId,
      params.mediaSourceId,
      stream.index,
      stream.codec,
    );
  } catch (error) {
    return {
      ok: false,
      message: `Failed to fetch subtitles: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  const cues = shiftCuesForClip(
    parseSubtitleContent(raw.content, raw.format),
    params.clipStartSeconds,
    params.clipEndSeconds,
  );

  if (cues.length === 0) {
    return { ok: false, message: "No subtitle cues overlap this clip range." };
  }

  await writeSrtFile(cues, params.outputPath);
  return { ok: true };
}
