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

/**
 * Semver-aware tag comparator. Returns negative when `a < b`, zero when
 * equal, positive when `a > b`. Tags that fail to parse fall back to
 * lexical comparison and rank below valid semver tags so they never
 * leapfrog real releases in a gap walk. Issue #156.
 */
export function compareReleaseTags(a: string, b: string): number {
  const va = parseReleaseVersion(a);
  const vb = parseReleaseVersion(b);
  if (!va && !vb) return a.localeCompare(b);
  if (!va) return -1;
  if (!vb) return 1;
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}
