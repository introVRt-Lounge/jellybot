import type {
  RadarrClient,
  RadarrLookupResult,
  RadarrMovie,
  RadarrQualityProfile,
  RadarrRootFolder,
} from "./client.ts";

export type AcquisitionDefaults = {
  qualityProfileId: number;
  rootFolderPath: string;
  rootFolderFreeBytes: number;
};

export type AcquisitionRefusal =
  | { kind: "no_candidates" }
  | { kind: "no_quality_profile"; available: string[] }
  | { kind: "no_root_folder"; tried: string }
  | { kind: "low_disk_space"; freeGb: number; minGb: number; rootPath: string };

export type AcquisitionPick = {
  candidate: RadarrLookupResult;
  alternatives: RadarrLookupResult[];
};

export function pickBestCandidate(
  results: RadarrLookupResult[],
  hint: { movieText: string; year?: number },
): AcquisitionPick | { kind: "no_candidates" } {
  if (results.length === 0) {
    return { kind: "no_candidates" };
  }

  const cleanedHint = normalise(hint.movieText);
  const scored = results
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, cleanedHint, hint.year),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  if (top.score <= 0 && results.length > 0) {
    return { candidate: results[0]!, alternatives: results.slice(1, 5) };
  }

  return {
    candidate: top.candidate,
    alternatives: scored
      .slice(1, 5)
      .map((entry) => entry.candidate),
  };
}

export async function resolveAcquisitionDefaults(
  client: RadarrClient,
  override: { qualityProfileId?: number; rootFolderPath?: string },
): Promise<AcquisitionDefaults | AcquisitionRefusal> {
  const [profiles, roots] = await Promise.all([client.qualityProfiles(), client.rootFolders()]);

  const profile = pickQualityProfile(profiles, override.qualityProfileId);
  if (!profile) {
    return { kind: "no_quality_profile", available: profiles.map((p) => p.name) };
  }

  const root = pickRootFolder(roots, override.rootFolderPath);
  if (!root) {
    return {
      kind: "no_root_folder",
      tried: override.rootFolderPath ?? "(no override; default not found)",
    };
  }

  return {
    qualityProfileId: profile.id,
    rootFolderPath: root.path,
    rootFolderFreeBytes: root.freeSpace,
  };
}

export function checkDiskSpace(
  defaults: AcquisitionDefaults,
  minFreeGb: number,
): AcquisitionRefusal | null {
  const freeGb = defaults.rootFolderFreeBytes / 1024 ** 3;
  if (freeGb < minFreeGb) {
    return {
      kind: "low_disk_space",
      freeGb: Math.round(freeGb * 10) / 10,
      minGb: minFreeGb,
      rootPath: defaults.rootFolderPath,
    };
  }
  return null;
}

export async function acquireMovie(input: {
  client: RadarrClient;
  candidate: RadarrLookupResult;
  defaults: AcquisitionDefaults;
}): Promise<RadarrMovie> {
  return input.client.addMovie({
    tmdbId: input.candidate.tmdbId,
    qualityProfileId: input.defaults.qualityProfileId,
    rootFolderPath: input.defaults.rootFolderPath,
    monitored: true,
    searchOnAdd: true,
  });
}

function pickQualityProfile(
  profiles: RadarrQualityProfile[],
  override: number | undefined,
): RadarrQualityProfile | null {
  if (override !== undefined) {
    return profiles.find((p) => p.id === override) ?? null;
  }
  // Heuristic: prefer "HD-1080p (no 4K)" or "HD-1080p" or fallback to first.
  const preferredOrder = ["HD-1080p (no 4K)", "HD-1080p", "HD - 720p/1080p", "HD-720p"];
  for (const name of preferredOrder) {
    const match = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return profiles[0] ?? null;
}

function pickRootFolder(
  roots: RadarrRootFolder[],
  override: string | undefined,
): RadarrRootFolder | null {
  if (override) {
    return roots.find((r) => r.path === override) ?? null;
  }
  // Default: take the first accessible root that isn't obviously the "erotic" stash.
  const cleanRoots = roots.filter(
    (r) => r.accessible !== false && !/erotic|adult|porn/i.test(r.path),
  );
  return cleanRoots[0] ?? roots[0] ?? null;
}

function scoreCandidate(
  candidate: RadarrLookupResult,
  cleanedHint: string,
  hintYear: number | undefined,
): number {
  let score = 0;
  const cleanedTitle = normalise(candidate.title);
  if (cleanedTitle === cleanedHint) {
    score += 100;
  } else if (cleanedTitle.includes(cleanedHint) || cleanedHint.includes(cleanedTitle)) {
    score += 60;
  } else {
    const hintTokens = new Set(cleanedHint.split(" ").filter(Boolean));
    const titleTokens = new Set(cleanedTitle.split(" ").filter(Boolean));
    let intersect = 0;
    for (const token of hintTokens) {
      if (titleTokens.has(token)) intersect += 1;
    }
    if (hintTokens.size > 0) {
      score += Math.round((intersect / hintTokens.size) * 40);
    }
  }

  if (hintYear && candidate.year === hintYear) {
    score += 20;
  } else if (candidate.year) {
    // Mild bias toward older / more "classic" matches when the user didn't supply a year.
    score += 1;
  }

  if (!candidate.year) {
    score -= 5;
  }

  return score;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\s'&]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
