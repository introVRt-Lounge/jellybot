type GitHubRequestOptions = {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
};

export async function fetchGitHubJson<T>(options: GitHubRequestOptions): Promise<T> {
  const url = `https://api.github.com/repos/${options.repoOwner}/${options.repoName}${options.path}`;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "jellybot-release-announcer",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal ?? AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub API failed (${options.path}): ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export type GitHubCompareCommit = {
  sha: string;
  commit: {
    message: string;
    author: { name: string | null };
  };
  author: { login: string | null } | null;
};

export async function fetchCompareCommits(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  baseTag: string,
  headTag: string,
): Promise<GitHubCompareCommit[]> {
  const payload = await fetchGitHubJson<{ commits?: GitHubCompareCommit[] }>({
    repoOwner,
    repoName,
    githubToken,
    path: `/compare/${encodeURIComponent(baseTag)}...${encodeURIComponent(headTag)}`,
  });
  return payload.commits ?? [];
}

export async function fetchReleaseTags(
  repoOwner: string,
  repoName: string,
  githubToken: string,
): Promise<string[]> {
  const payload = await fetchGitHubJson<
    Array<{ tag_name: string; draft?: boolean; prerelease?: boolean; published_at?: string }>
  >({
    repoOwner,
    repoName,
    githubToken,
    path: "/releases?per_page=100",
  });

  return payload
    .filter((release) => !release.draft && !release.prerelease && release.tag_name)
    .sort((left, right) => {
      const leftTime = Date.parse(left.published_at ?? "");
      const rightTime = Date.parse(right.published_at ?? "");
      return rightTime - leftTime;
    })
    .map((release) => release.tag_name);
}

export async function fetchPullRequestAuthorLogin(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  pullNumber: number,
): Promise<string | null> {
  const payload = await fetchGitHubJson<{ user?: { login?: string } | null; body?: string | null }>({
    repoOwner,
    repoName,
    githubToken,
    path: `/pulls/${pullNumber}`,
  });
  return payload.user?.login ?? null;
}

export async function fetchPullRequestBody(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  pullNumber: number,
): Promise<string | null> {
  const payload = await fetchGitHubJson<{ body?: string | null }>({
    repoOwner,
    repoName,
    githubToken,
    path: `/pulls/${pullNumber}`,
  });
  return payload.body ?? null;
}

export type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  state?: "open" | "closed";
};

export async function fetchIssue(
  repoOwner: string,
  repoName: string,
  githubToken: string,
  issueNumber: number,
): Promise<GitHubIssue | null> {
  try {
    const payload = await fetchGitHubJson<{
      number?: number;
      title?: string;
      body?: string | null;
      state?: string;
    }>({
      repoOwner,
      repoName,
      githubToken,
      path: `/issues/${issueNumber}`,
    });
    if (!payload.number || !payload.title) {
      return null;
    }
    return {
      number: payload.number,
      title: payload.title,
      body: payload.body ?? null,
      state: payload.state === "closed" ? "closed" : "open",
    };
  } catch {
    return null;
  }
}

export async function fetchGitHubUserName(githubToken: string, login: string): Promise<string | null> {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "jellybot-release-announcer",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { name?: string | null; login?: string };
  const name = payload.name?.trim();
  return name || payload.login || login;
}
