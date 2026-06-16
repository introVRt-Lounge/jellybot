export type GitHubRelease = {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
  draft?: boolean;
  prerelease?: boolean;
};

export async function fetchLatestRelease(
  repoOwner: string,
  repoName: string,
  githubToken: string,
): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;
  return fetchReleaseFromUrl(url, repoOwner, repoName, githubToken);
}

export async function fetchReleaseByTag(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/${encodeURIComponent(tag)}`;
  return fetchReleaseFromUrl(url, repoOwner, repoName, githubToken);
}

export type ListReleasesOptions = {
  /**
   * Stop fetching pages as soon as a release with this tag is encountered.
   * The release with `stopTag` is included in the result. Used by the
   * announcer to bound the walk to "everything since last announce".
   */
  stopTag?: string;
  /** Hard cap on pages fetched. Default 5. Each page = `perPage` releases. */
  maxPages?: number;
  /** Page size, capped server-side at 100. Default 100. */
  perPage?: number;
};

export type ListReleasesResult = {
  /** Releases newest-first across all walked pages. Drafts and pre-releases excluded. */
  releases: GitHubRelease[];
  /**
   * `true` when `stopTag` was found in the walked window (or no `stopTag`
   * was requested and the API returned a final, partial page indicating
   * the entire history fits in `releases`). Callers can safely advance
   * their cursor past the most recent visible release.
   *
   * `false` when the walk hit `maxPages` without encountering `stopTag`.
   * Callers MUST NOT mark anything past the oldest fetched release as
   * handled, because earlier releases live beyond the walked window.
   */
  foundStopTag: boolean;
  /** `true` when the walk stopped because it hit `maxPages`. Issue #158. */
  exhausted: boolean;
};

/**
 * Walk the releases endpoint newest-first across pages, stopping when
 * `stopTag` is encountered or `maxPages` is exhausted. Drafts and
 * pre-releases are filtered out. Issue #158: prior single-page fetch
 * could silently leapfrog feats whose tags fell off the first page when
 * the announcer was broken for many releases.
 */
export async function listReleases(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  options: ListReleasesOptions = {},
): Promise<ListReleasesResult> {
  const perPage = Math.min(Math.max(options.perPage ?? 100, 1), 100);
  const maxPages = Math.max(options.maxPages ?? 5, 1);
  const stopTag = options.stopTag;

  const collected: GitHubRelease[] = [];
  let foundStopTag = false;
  let exhausted = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/releases?per_page=${perPage}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "jellybot-release-announcer",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`GitHub releases list API failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as Array<Partial<GitHubRelease>>;
    for (const r of payload) {
      if (!r.tag_name || r.draft || r.prerelease) continue;
      collected.push({
        tag_name: r.tag_name,
        name: r.name ?? r.tag_name,
        body: r.body ?? "",
        html_url: r.html_url ?? `https://github.com/${repoOwner}/${repoName}/releases/tag/${r.tag_name}`,
        published_at: r.published_at ?? "",
        draft: r.draft,
        prerelease: r.prerelease,
      });
      if (stopTag && r.tag_name === stopTag) {
        foundStopTag = true;
        return { releases: collected, foundStopTag, exhausted };
      }
    }

    // Short page (< perPage) means the API has exhausted history. The
    // entire visible release set is in `collected`. Even if `stopTag`
    // wasn't seen, it doesn't exist behind another page (deleted, never
    // pushed, etc.) - it's safe to advance the caller's cursor.
    if (payload.length < perPage) {
      return { releases: collected, foundStopTag: true, exhausted };
    }
  }

  exhausted = true;
  return { releases: collected, foundStopTag, exhausted };
}

async function fetchReleaseFromUrl(
  url: string,
  repoOwner: string,
  repoName: string,
  _githubToken: string,
): Promise<GitHubRelease | null> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${_githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "jellybot-release-announcer",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub releases API failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as Partial<GitHubRelease>;
  if (!payload.tag_name) {
    return null;
  }

  return {
    tag_name: payload.tag_name,
    name: payload.name ?? payload.tag_name,
    body: payload.body ?? "",
    html_url: payload.html_url ?? `https://github.com/${repoOwner}/${repoName}/releases/tag/${payload.tag_name}`,
    published_at: payload.published_at ?? "",
    draft: payload.draft,
    prerelease: payload.prerelease,
  };
}
