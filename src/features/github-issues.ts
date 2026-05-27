import { fetchGitHubJson } from "../release/github-api.ts";

export async function createFeatureSuggestionIssue(options: {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  title: string;
  body: string;
  reporterDiscordId: string;
  reporterDiscordName: string;
}): Promise<{ number: number; htmlUrl: string }> {
  const bodyWithReporter = `${options.body}\n\n**Reported by:** Discord \`${options.reporterDiscordName}\` (\`${options.reporterDiscordId}\`)`;

  const payload = await fetchGitHubJson<{ number: number; html_url: string }>({
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    githubToken: options.githubToken,
    path: "/issues",
    method: "POST",
    body: {
      title: options.title,
      body: bodyWithReporter,
      labels: ["enhancement", "user-suggested", "triage"],
    },
  });

  return { number: payload.number, htmlUrl: payload.html_url };
}

export async function blessFeatureIssueForTriage(options: {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  issueNumber: number;
}): Promise<void> {
  await fetchGitHubJson({
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    githubToken: options.githubToken,
    path: `/issues/${options.issueNumber}/labels`,
    method: "POST",
    body: { labels: ["discord-triage-blessed", "ai-safe"] },
  });
}
