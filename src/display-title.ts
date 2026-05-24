export type DisplayTitleInput = {
  name: string;
  originalTitle?: string;
  type?: string;
};

const RELEASE_FILENAME_PATTERN =
  /\b(2160|1080|720|576|480|360)p\b|\b(x264|x265|hevc|h\.?264|h\.?265|bluray|webrip|web-dl|dvdrip|proper|repack|rarbg|yts|sparks|geckos)\b/i;

export function looksLikeReleaseFilename(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;

  if (RELEASE_FILENAME_PATTERN.test(trimmed)) {
    return true;
  }

  const dotCount = trimmed.match(/\./g)?.length ?? 0;
  return dotCount >= 3 && !trimmed.includes(" ");
}

export function displayTitle(item: DisplayTitleInput): string {
  const name = item.name.trim();
  const originalTitle = item.originalTitle?.trim();

  if (originalTitle) {
    if (item.type === "Movie") {
      if (looksLikeReleaseFilename(name) || name !== originalTitle) {
        return originalTitle;
      }
    }

    if (item.type === "Episode" && looksLikeReleaseFilename(name)) {
      return originalTitle;
    }
  }

  return name || originalTitle || "Unknown";
}

export function displayTitleWithYear(item: DisplayTitleInput & { productionYear?: number }): string {
  const title = displayTitle(item);
  if (item.productionYear) {
    return `${title} (${item.productionYear})`;
  }

  return title;
}
