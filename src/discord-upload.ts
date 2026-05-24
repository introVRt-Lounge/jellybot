const BYTES_PER_MB = 1024 * 1024;
const UPLOAD_SAFETY_RATIO = 0.95;

export function maxClipMbForDiscordUpload(attachmentSizeLimitBytes: number, configuredMaxClipMb: number): number {
  if (!Number.isFinite(attachmentSizeLimitBytes) || attachmentSizeLimitBytes <= 0) {
    return configuredMaxClipMb;
  }

  const discordLimitMb = (attachmentSizeLimitBytes / BYTES_PER_MB) * UPLOAD_SAFETY_RATIO;
  return Math.min(configuredMaxClipMb, discordLimitMb);
}

export function formatDiscordUploadLimit(attachmentSizeLimitBytes: number): string {
  return `${(attachmentSizeLimitBytes / BYTES_PER_MB).toFixed(1)} MB`;
}
