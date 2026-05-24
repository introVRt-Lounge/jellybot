import webvtt from "node-webvtt";

export type ParsedCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

const SRT_BLOCK_PATTERN = /(\d+)\s*\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\s*\n([\s\S]*?)(?=\n\d+\s*\n|\n*$)/g;

export function normalizeCueText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSubtitleContent(content: string, format: "vtt" | "srt" = "vtt"): ParsedCue[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (format === "srt") {
    return parseSrt(trimmed);
  }

  if (trimmed.startsWith("WEBVTT")) {
    return parseVtt(trimmed);
  }

  const srtCues = parseSrt(trimmed);
  if (srtCues.length > 0) {
    return srtCues;
  }

  return parseVtt(trimmed);
}

function parseVtt(content: string): ParsedCue[] {
  const parsed = webvtt.parse(content);
  const cues: ParsedCue[] = [];

  for (const cue of parsed.cues ?? []) {
    const text = normalizeCueText(cue.text ?? "");
    if (!text) continue;
    cues.push({
      startSeconds: cue.start,
      endSeconds: cue.end,
      text,
    });
  }

  return cues;
}

function parseSrt(content: string): ParsedCue[] {
  const cues: ParsedCue[] = [];
  SRT_BLOCK_PATTERN.lastIndex = 0;

  for (const match of content.matchAll(SRT_BLOCK_PATTERN)) {
    const text = normalizeCueText(match[4] ?? "");
    if (!text) continue;

    cues.push({
      startSeconds: parseSrtTimestamp(match[2] ?? ""),
      endSeconds: parseSrtTimestamp(match[3] ?? ""),
      text,
    });
  }

  return cues;
}

function parseSrtTimestamp(value: string): number {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return 0;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}
