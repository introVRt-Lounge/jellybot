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

/**
 * List releases newest-first. Drafts and pre-releases are excluded.
 * `perPage` defaults to 30 - more than enough for any gap the bot would
 * sanely walk on a Watchtower recreate; if the gap is larger than that
 * something else is wrong (announcer broken for weeks). Issue #156.
 */
export async function listReleases(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  perPage = 30,
): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/releases?per_page=${perPage}`;
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
  return payload
    .filter((r) => Boolean(r.tag_name) && !r.draft && !r.prerelease)
    .map((r) => ({
      tag_name: r.tag_name as string,
      name: r.name ?? (r.tag_name as string),
      body: r.body ?? "",
      html_url: r.html_url ?? `https://github.com/${repoOwner}/${repoName}/releases/tag/${r.tag_name}`,
      published_at: r.published_at ?? "",
      draft: r.draft,
      prerelease: r.prerelease,
    }));
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
