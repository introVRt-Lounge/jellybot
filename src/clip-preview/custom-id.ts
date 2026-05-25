const PREFIX = "jb-preview";

export type PreviewButtonAction = "post" | "cancel" | "retry";

export function previewButtonCustomId(action: PreviewButtonAction, sessionId: string): string {
  return `${PREFIX}:${action}:${sessionId}`;
}

export function previewModalCustomId(sessionId: string): string {
  return `${PREFIX}:modal:${sessionId}`;
}

export function parsePreviewButtonCustomId(
  customId: string,
): { action: PreviewButtonAction; sessionId: string } | null {
  const match = customId.match(/^jb-preview:(post|cancel|retry):([a-z0-9-]+)$/i);
  if (!match) return null;
  return { action: match[1] as PreviewButtonAction, sessionId: match[2]! };
}

export function parsePreviewModalCustomId(customId: string): { sessionId: string } | null {
  const match = customId.match(/^jb-preview:modal:([a-z0-9-]+)$/i);
  if (!match) return null;
  return { sessionId: match[1]! };
}

export function isPreviewInteractionCustomId(customId: string): boolean {
  return customId.startsWith(`${PREFIX}:`);
}
