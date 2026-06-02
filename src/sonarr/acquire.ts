import type {
  SonarrClient,
  SonarrEpisode,
  SonarrLanguageProfile,
  SonarrLookupResult,
  SonarrQualityProfile,
  SonarrRootFolder,
  SonarrSeries,
} from "./client.ts";

export type SonarrAcquisitionDefaults = {
  qualityProfileId: number;
  languageProfileId?: number;
  rootFolderPath: string;
  rootFolderFreeBytes: number;
};

export type SonarrAcquisitionRefusal =
  | { kind: "no_candidates" }
  | { kind: "no_quality_profile"; available: string[] }
  | { kind: "no_root_folder"; tried: string }
  | { kind: "low_disk_space"; freeGb: number; minGb: number; rootPath: string };

export type SonarrAcquisitionPick = {
  candidate: SonarrLookupResult;
  alternatives: SonarrLookupResult[];
};

export type SonarrAcquisitionResult = {
  series: SonarrSeries;
  episode: SonarrEpisode;
  /** True if the series existed before this call (we just monitored an episode). */
  alreadyAdded: boolean;
};

export type ExcludedRootMatcher = (path: string) => boolean;

/**
 * Score and rank Sonarr lookup results for a user-supplied show title.
 * Mirrors `pickBestCandidate` in src/radarr/acquire.ts but operates on tvdbId.
 */
export function pickBestSeries(
  results: SonarrLookupResult[],
  hint: { showText: string; year?: number },
): SonarrAcquisitionPick | { kind: "no_candidates" } {
  if (results.length === 0) {
    return { kind: "no_candidates" };
  }

  const cleanedHint = normalise(hint.showText);
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
    alternatives: scored.slice(1, 5).map((entry) => entry.candidate),
  };
}

export async function resolveSonarrDefaults(
  client: SonarrClient,
  override: { qualityProfileId?: number; rootFolderPath?: string },
  options: { excludedRootMatcher?: ExcludedRootMatcher } = {},
): Promise<SonarrAcquisitionDefaults | SonarrAcquisitionRefusal> {
  const [profiles, languages, roots] = await Promise.all([
    client.qualityProfiles(),
    client.languageProfiles(),
    client.rootFolders(),
  ]);

  const profile = pickQualityProfile(profiles, override.qualityProfileId);
  if (!profile) {
    return { kind: "no_quality_profile", available: profiles.map((p) => p.name) };
  }

  const root = pickRootFolder(roots, override.rootFolderPath, options.excludedRootMatcher);
  if (!root) {
    return {
      kind: "no_root_folder",
      tried: override.rootFolderPath ?? "(no override; default not found)",
    };
  }

  const languageProfileId = pickLanguageProfile(languages);

  return {
    qualityProfileId: profile.id,
    languageProfileId,
    rootFolderPath: root.path,
    rootFolderFreeBytes: root.freeSpace,
  };
}

export function checkSonarrDiskSpace(
  defaults: SonarrAcquisitionDefaults,
  minFreeGb: number,
): SonarrAcquisitionRefusal | null {
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

/**
 * Add the series unmonitored if not already present, then monitor + search the
 * specific episode. Returns the existing or newly-created Sonarr series along
 * with the targeted episode and a flag indicating whether the series was a
 * pre-existing record.
 */
export async function acquireEpisode(input: {
  client: SonarrClient;
  candidate: SonarrLookupResult;
  defaults: SonarrAcquisitionDefaults;
  seasonNumber: number;
  episodeNumber: number;
}): Promise<SonarrAcquisitionResult> {
  const existing = await input.client.findSeriesByTvdbId(input.candidate.tvdbId);
  let series: SonarrSeries;
  let alreadyAdded: boolean;

  if (existing) {
    series = existing;
    alreadyAdded = true;
  } else {
    series = await input.client.addSeriesUnmonitored({
      tvdbId: input.candidate.tvdbId,
      qualityProfileId: input.defaults.qualityProfileId,
      languageProfileId: input.defaults.languageProfileId,
      rootFolderPath: input.defaults.rootFolderPath,
      title: input.candidate.title,
    });
    alreadyAdded = false;
  }

  const episode = await input.client.findEpisode(
    series.id,
    input.seasonNumber,
    input.episodeNumber,
  );
  if (!episode) {
    throw new Error(
      `Sonarr has series id=${series.id} but no episode S${input.seasonNumber}E${input.episodeNumber} in its episode list.`,
    );
  }

  if (!episode.monitored) {
    await input.client.setEpisodeMonitored(episode.id, true);
  }

  // Issue the search whether or not the episode already had a file - if it has
  // a file the user can confirm with the live `/quote` command anyway, and the
  // search is a cheap no-op when the file exists.
  if (!episode.hasFile) {
    await input.client.episodeSearch([episode.id]);
  }

  return { series, episode, alreadyAdded };
}

function pickQualityProfile(
  profiles: SonarrQualityProfile[],
  override: number | undefined,
): SonarrQualityProfile | null {
  if (override !== undefined) {
    return profiles.find((p) => p.id === override) ?? null;
  }
  // Heuristic mirroring Radarr: prefer 1080p variants, fall back to first.
  const preferredOrder = ["HD-1080p (no 4K)", "HD-1080p", "HD - 720p/1080p", "HD-720p"];
  for (const name of preferredOrder) {
    const match = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return profiles[0] ?? null;
}

function pickLanguageProfile(profiles: SonarrLanguageProfile[]): number | undefined {
  if (profiles.length === 0) return undefined;
  const english = profiles.find((p) => /english/i.test(p.name));
  return (english ?? profiles[0])!.id;
}

function pickRootFolder(
  roots: SonarrRootFolder[],
  override: string | undefined,
  excluded: ExcludedRootMatcher | undefined,
): SonarrRootFolder | null {
  if (override) {
    return roots.find((r) => r.path === override) ?? null;
  }
  const isAccessible = (r: SonarrRootFolder) => r.accessible !== false;
  const isExcluded = (r: SonarrRootFolder) => (excluded ? excluded(r.path) : false);
  const usable = roots.filter((r) => isAccessible(r) && !isExcluded(r));
  return usable[0] ?? roots.find((r) => !isExcluded(r)) ?? roots[0] ?? null;
}

function scoreCandidate(
  candidate: SonarrLookupResult,
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
    score += 1;
  }

  if (!candidate.year) {
    score -= 5;
  }

  // Prefer ended/continuing over upcoming.
  if (candidate.status === "ended" || candidate.status === "continuing") {
    score += 2;
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
