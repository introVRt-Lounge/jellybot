import {
  fetchCompareCommits,
  fetchGitHubUserName,
  fetchIssue,
  fetchPullRequestBody,
  fetchReleaseTags,
} from "./github-api.ts";
import { parsePullRequestNumber } from "./release-feature-credits.ts";
import {
  formatCommunityCredits,
  parseLinkedIssueNumbers,
  parseReportedByLogin,
  summarizeIssueTitle,
  type CommunityCredit,
} from "./release-community-credits.ts";
import { findPreviousReleaseTag } from "./release-feature-credits.ts";

export async function buildCommunityCreditsForRelease(options: {
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

  const pullNumbers = new Set<number>();
  for (const commit of commits) {
    const pullNumber = parsePullRequestNumber(commit.commit.message);
    if (pullNumber) {
      pullNumbers.add(pullNumber);
    }
  }

  const issueNumbers = new Set<number>();
  for (const pullNumber of pullNumbers) {
    const body = await fetchPullRequestBody(
      options.repoOwner,
      options.repoName,
      options.githubToken,
      pullNumber,
    );
    if (!body) {
      continue;
    }
    for (const issueNumber of parseLinkedIssueNumbers(body)) {
      issueNumbers.add(issueNumber);
    }
  }

  const credits: CommunityCredit[] = [];
  const seen = new Set<string>();

  for (const issueNumber of issueNumbers) {
    const issue = await fetchIssue(options.repoOwner, options.repoName, options.githubToken, issueNumber);
    if (!issue) {
      continue;
    }

    const login = parseReportedByLogin(issue.body);
    if (!login) {
      continue;
    }

    const dedupeKey = `${issueNumber}::${login.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const displayName = (await fetchGitHubUserName(options.githubToken, login)) ?? login;
    credits.push({
      summary: summarizeIssueTitle(issue.title),
      login,
      displayName,
    });
  }

  return formatCommunityCredits(credits);
}
