import { isJellyfinItemId } from "../jellyfin.ts";

const MATCH_TOKEN_PATTERN = /^([a-f0-9]{32}):(\d+):(\d+)$/i;

export type QuoteMatchToken = {
  itemId: string;
  startMs: number;
  endMs: number;
};

export function encodeQuoteMatchToken(match: QuoteMatchToken): string {
  return `${match.itemId}:${match.startMs}:${match.endMs}`;
}

export function parseQuoteMatchToken(value: string): QuoteMatchToken | null {
  const match = value.trim().match(MATCH_TOKEN_PATTERN);
  if (!match) return null;

  const itemId = match[1]!;
  if (!isJellyfinItemId(itemId)) return null;

  const startMs = Number(match[2]);
  const endMs = Number(match[3]);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }

  return { itemId, startMs, endMs };
}
