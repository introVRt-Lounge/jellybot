export type SemVerParts = {
  major: number;
  minor: number;
  patch: number;
};

export function parseReleaseVersion(tag: string): SemVerParts | null {
  if (!tag.trim()) {
    return null;
  }

  const clean = tag.trim().replace(/^v/i, "").split("+", 1)[0]?.split("-", 1)[0] ?? "";
  const parts = clean.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const major = Number.parseInt(parts[0] ?? "", 10);
    const minor = Number.parseInt(parts[1] ?? "", 10);
    const patch = parts.length >= 3 ? Number.parseInt(parts[2] ?? "", 10) : 0;
    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
      return null;
    }
    return { major, minor, patch };
  } catch {
    return null;
  }
}

export function isPatchRelease(tag: string): boolean {
  const parsed = parseReleaseVersion(tag);
  if (!parsed) {
    return false;
  }
  return parsed.patch > 0;
}

export function isMajorOrMinorRelease(tag: string): boolean {
  const parsed = parseReleaseVersion(tag);
  if (!parsed) {
    return false;
  }
  return parsed.patch === 0;
}

export function looksLikeReleaseTag(value: string): boolean {
  return parseReleaseVersion(value) !== null;
}
