import { discordMentionForGitHubLogin } from "./github-discord-members.ts";

export type CommunityCredit = {
  summary: string;
  login: string;
  displayName: string;
};

const FIXES_ISSUE_PATTERN = /(?:fixes|closes|resolves)\s+#(\d+)/gi;
export const REPORTED_BY_PATTERN = /Reported by\s+@([A-Za-z0-9_-]+)/i;

export function parseLinkedIssueNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(FIXES_ISSUE_PATTERN)) {
    const issueNumber = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isNaN(issueNumber)) {
      numbers.add(issueNumber);
    }
  }
  return [...numbers];
}

export function parseReportedByLogin(issueBody: string | null | undefined): string | null {
  const match = issueBody?.match(REPORTED_BY_PATTERN);
  return match?.[1]?.trim() ?? null;
}

export function summarizeIssueTitle(title: string): string {
  return title
    .replace(/^\[(?:feat|fix|bug|chore|docs|refactor|infra|test|ux)\]:\s*/i, "")
    .trim();
}

export function formatGitHubPerson(displayName: string, login: string): string {
  const mention = discordMentionForGitHubLogin(login);
  let person: string;
  if (displayName && displayName !== login) {
    person = `${displayName} (@${login})`;
  } else {
    person = `@${login}`;
  }
  return mention ? `${person} ${mention}` : person;
}

export function formatCommunityCredits(credits: CommunityCredit[]): string | null {
  if (credits.length === 0) {
    return null;
  }

  return credits
    .map((credit) => `- ${credit.summary} — reported by ${formatGitHubPerson(credit.displayName, credit.login)}`)
    .join("\n");
}
