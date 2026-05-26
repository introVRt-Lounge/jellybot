import {
  fetchCompareCommits,
  fetchGitHubUserName,
  fetchPullRequestAuthorLogin,
  fetchReleaseTags,
  type GitHubCompareCommit,
} from "./github-api.ts";
import { formatGitHubPerson as formatPersonWithMention } from "./release-community-credits.ts";

export type FeatureCredit = {
  summary: string;
  login: string;
  displayName: string;
};

const FEAT_COMMIT_PATTERN = /^feat(?:\([^)]+\))?!?:\s*(.+)$/i;
const PULL_NUMBER_PATTERN = /\(#(\d+)\)\s*$/;

function firstLine(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

export function parseFeatureSummary(commitMessage: string): string | null {
  const line = firstLine(commitMessage);
  const match = line.match(FEAT_COMMIT_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(PULL_NUMBER_PATTERN, "").trim();
}

export function parsePullRequestNumber(commitMessage: string): number | null {
  const line = firstLine(commitMessage);
  const match = line.match(PULL_NUMBER_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const pullNumber = Number.parseInt(match[1], 10);
  return Number.isNaN(pullNumber) ? null : pullNumber;
}

export function formatGitHubPerson(displayName: string, login: string): string {
  return formatPersonWithMention(displayName, login);
}

export function formatFeatureCredits(credits: FeatureCredit[]): string | null {
  if (credits.length === 0) {
    return null;
  }

  return credits
    .map((credit) => `- ${credit.summary} — ${formatGitHubPerson(credit.displayName, credit.login)}`)
    .join("\n");
}

export function findPreviousReleaseTag(currentTag: string, releaseTags: string[]): string | null {
  const index = releaseTags.indexOf(currentTag);
  if (index >= 0 && index + 1 < releaseTags.length) {
    return releaseTags[index + 1] ?? null;
  }
  return null;
}

async function resolveResponsibleLogin(
  commit: GitHubCompareCommit,
  repoOwner: string,
  repoName: string,
  githubToken: string,
): Promise<string | null> {
  const pullNumber = parsePullRequestNumber(commit.commit.message);
  if (pullNumber) {
    const pullAuthor = await fetchPullRequestAuthorLogin(repoOwner, repoName, githubToken, pullNumber);
    if (pullAuthor) {
      return pullAuthor;
    }
  }

  return commit.author?.login ?? null;
}

export async function buildFeatureCreditsForRelease(options: {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  currentTag: string;
}): Promise<string | null> {
  const releaseTags = await fetchReleaseTags(options.repoOwner, options.repoName, options.githubToken);
  const previousTag = findPreviousReleaseTag(options.currentTag, releaseTags);
  if (!previousTag) {
    return null;
  }

  const commits = await fetchCompareCommits(
    options.repoOwner,
    options.repoName,
    options.githubToken,
    previousTag,
    options.currentTag,
  );

  const credits: FeatureCredit[] = [];
  const seen = new Set<string>();

  for (const commit of commits) {
    const summary = parseFeatureSummary(commit.commit.message);
    if (!summary) {
      continue;
    }

    const login = await resolveResponsibleLogin(commit, options.repoOwner, options.repoName, options.githubToken);
    if (!login || login.endsWith("[bot]")) {
      continue;
    }

    const dedupeKey = `${summary.toLowerCase()}::${login.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const displayName =
      (await fetchGitHubUserName(options.githubToken, login)) ??
      commit.commit.author.name?.trim() ??
      login;

    credits.push({ summary, login, displayName });
  }

  return formatFeatureCredits(credits);
}
