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
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
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
