import { fetchGitHubJson } from "../release/github-api.ts";
import {
  PIPELINE_AGENT_ID_MARKER,
  PIPELINE_STAGE_LABELS,
  branchNameForIssue,
  parseAgentIdFromText,
  type PipelineChecklistItem,
  type PipelineStageId,
} from "./pipeline-stages.ts";

type GitHubIssuePayload = {
  number: number;
  state: string;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
};

type GitHubPullPayload = {
  number: number;
  state: string;
  html_url: string;
  merged_at: string | null;
  head: { ref: string };
};

type GitHubCommentPayload = {
  body: string | null;
};

type StatusCheckRollup = {
  name: string;
  conclusion: string | null;
  status: string;
};

export type PipelineInspection = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueState: "open" | "closed";
  stage: PipelineStageId;
  stageLabel: string;
  blocker: string | null;
  branchName: string;
  branchExists: boolean;
  prNumber: number | null;
  prState: string | null;
  prUrl: string | null;
  ciConclusion: string | null;
  scopeReviewConclusion: string | null;
  labels: string[];
  agentId: string | null;
  agentUrl: string | null;
  merged: boolean;
  checklist: PipelineChecklistItem[];
};

export async function inspectFeaturePipeline(options: {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  issueNumber: number;
}): Promise<PipelineInspection> {
  const branchName = branchNameForIssue(options.issueNumber);

  const issue = await fetchGitHubJson<GitHubIssuePayload>({
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    githubToken: options.githubToken,
    path: `/issues/${options.issueNumber}`,
  });

  const labels = issue.labels.map((label) => label.name);
  const issueState = issue.state === "closed" ? "closed" : "open";

  const agentId = await findAgentIdInIssueComments(options);
  const branchExists = await branchExistsOnGitHub(options, branchName);
  const pull = await findPullRequestForBranch(options, branchName);

  const ciConclusion = pull ? await readCheckConclusion(options, pull.number, "ci") : null;
  const scopeReviewConclusion = pull ? await readCheckConclusion(options, pull.number, "scope-review") : null;

  const merged = Boolean(pull?.merged_at);
  const checklist = buildChecklist({
    labels,
    issueState,
    branchExists,
    pull,
    ciConclusion,
    scopeReviewConclusion,
    merged,
    agentId,
    branchName,
  });

  const { stage, blocker } = deriveStageAndBlocker({
    labels,
    issueState,
    branchExists,
    pull,
    ciConclusion,
    scopeReviewConclusion,
    merged,
    agentId,
  });

  return {
    issueNumber: options.issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    issueState,
    stage,
    stageLabel: PIPELINE_STAGE_LABELS[stage],
    blocker,
    branchName,
    branchExists,
    prNumber: pull?.number ?? null,
    prState: pull?.state ?? null,
    prUrl: pull?.html_url ?? null,
    ciConclusion,
    scopeReviewConclusion,
    labels,
    agentId,
    agentUrl: agentId ? `https://cursor.com/agents?id=${encodeURIComponent(agentId)}` : null,
    merged,
    checklist,
  };
}

async function findAgentIdInIssueComments(options: {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  issueNumber: number;
}): Promise<string | null> {
  const comments = await fetchGitHubJson<GitHubCommentPayload[]>({
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    githubToken: options.githubToken,
    path: `/issues/${options.issueNumber}/comments?per_page=100`,
  });

  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.includes(PIPELINE_AGENT_ID_MARKER)) {
      continue;
    }
    const agentId = parseAgentIdFromText(body);
    if (agentId) {
      return agentId;
    }
  }

  return null;
}

async function branchExistsOnGitHub(
  options: { repoOwner: string; repoName: string; githubToken: string },
  branchName: string,
): Promise<boolean> {
  try {
    await fetchGitHubJson({
      repoOwner: options.repoOwner,
      repoName: options.repoName,
      githubToken: options.githubToken,
      path: `/branches/${encodeURIComponent(branchName)}`,
    });
    return true;
  } catch {
    return false;
  }
}

async function findPullRequestForBranch(
  options: { repoOwner: string; repoName: string; githubToken: string },
  branchName: string,
): Promise<GitHubPullPayload | null> {
  const pulls = await fetchGitHubJson<GitHubPullPayload[]>({
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    githubToken: options.githubToken,
    path: `/pulls?state=all&head=${encodeURIComponent(`${options.repoOwner}:${branchName}`)}&per_page=5`,
  });

  return pulls[0] ?? null;
}

async function readCheckConclusion(
  options: { repoOwner: string; repoName: string; githubToken: string },
  pullNumber: number,
  checkName: string,
): Promise<string | null> {
  try {
    const pull = await fetchGitHubJson<{ head: { sha: string } }>({
      repoOwner: options.repoOwner,
      repoName: options.repoName,
      githubToken: options.githubToken,
      path: `/pulls/${pullNumber}`,
    });

    const runs = await fetchGitHubJson<{ check_runs: StatusCheckRollup[] }>({
      repoOwner: options.repoOwner,
      repoName: options.repoName,
      githubToken: options.githubToken,
      path: `/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`,
    });

    const match = runs.check_runs.find((check) => check.name === checkName);
    if (!match) {
      return null;
    }
    return match.conclusion ?? match.status ?? null;
  } catch {
    return null;
  }
}

function buildChecklist(input: {
  labels: string[];
  issueState: "open" | "closed";
  branchExists: boolean;
  pull: GitHubPullPayload | null;
  ciConclusion: string | null;
  scopeReviewConclusion: string | null;
  merged: boolean;
  agentId: string | null;
  branchName: string;
}): PipelineChecklistItem[] {
  const blessed = input.labels.includes("discord-triage-blessed");
  const enqueued = input.labels.includes("ai-triage-enqueued");

  return [
    {
      step: "Blessed (`/feature choose`)",
      status: blessed ? "done" : "pending",
    },
    {
      step: "Triage enqueued",
      status: enqueued ? "done" : blessed ? "pending" : "pending",
    },
    {
      step: "Cursor agent started",
      status: input.agentId ? "done" : enqueued ? "pending" : "pending",
      detail: input.agentId ?? undefined,
    },
    {
      step: `Branch \`${input.branchName}\``,
      status: input.branchExists ? "done" : input.agentId || enqueued ? "pending" : "pending",
    },
    {
      step: "Pull request opened",
      status: input.pull ? "done" : input.branchExists ? "failed" : "pending",
      detail: input.pull ? `#${input.pull.number}` : input.branchExists ? "Branch exists but no PR — pipeline stuck here" : undefined,
    },
    {
      step: "CI (`ci`)",
      status: checkStatus(input.ciConclusion),
      detail: input.ciConclusion ?? undefined,
    },
    {
      step: "Scope review",
      status: checkStatus(input.scopeReviewConclusion),
      detail: input.scopeReviewConclusion ?? undefined,
    },
    {
      step: "Merged to main",
      status: input.merged ? "done" : input.pull?.state === "OPEN" ? "pending" : "pending",
    },
    {
      step: "Ship / deploy",
      status: input.merged ? "pending" : "pending",
      detail: input.merged ? "Watchtower picks up :latest after Ship main" : undefined,
    },
    {
      step: "GitHub issue open",
      status: input.issueState === "open" ? "done" : "warn",
      detail: input.issueState === "closed" ? "Issue is closed — auto-PR may fail" : undefined,
    },
  ];
}

function checkStatus(conclusion: string | null): PipelineChecklistItem["status"] {
  if (!conclusion) {
    return "pending";
  }
  if (conclusion === "SUCCESS") {
    return "done";
  }
  if (conclusion === "FAILURE" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT") {
    return "failed";
  }
  return "pending";
}

function deriveStageAndBlocker(input: {
  labels: string[];
  issueState: "open" | "closed";
  branchExists: boolean;
  pull: GitHubPullPayload | null;
  ciConclusion: string | null;
  scopeReviewConclusion: string | null;
  merged: boolean;
  agentId: string | null;
}): { stage: PipelineStageId; blocker: string | null } {
  if (!input.labels.includes("discord-triage-blessed")) {
    return { stage: "not_blessed", blocker: "Suggestion not blessed yet." };
  }

  if (input.issueState === "closed" && !input.merged) {
    return {
      stage: "failed",
      blocker:
        "GitHub issue is closed before ship — Cursor may not open a PR (check for accidental Fixes #N from another PR).",
    };
  }

  if (!input.labels.includes("ai-triage-enqueued")) {
    return {
      stage: "awaiting_enqueue",
      blocker: "Labels applied but triage workflow has not enqueued the Cursor agent yet.",
    };
  }

  if (!input.agentId && !input.branchExists) {
    return {
      stage: "awaiting_agent",
      blocker: "Cursor agent enqueued but no agent comment or branch yet — check cursor.com/agents or Actions → Cursor Issue Triage.",
    };
  }

  if (!input.branchExists) {
    return {
      stage: "awaiting_branch",
      blocker: input.agentId
        ? `Cursor agent ${input.agentId} running — waiting for branch push.`
        : "Waiting for agent to push the triage branch.",
    };
  }

  if (!input.pull) {
    return {
      stage: "awaiting_pr",
      blocker: "Agent pushed the branch but never opened a PR — open one manually or re-run the agent.",
    };
  }

  if (input.ciConclusion === "FAILURE" || input.ciConclusion === "CANCELLED" || input.ciConclusion === "TIMED_OUT") {
    return { stage: "failed", blocker: `CI failed (${input.ciConclusion}).` };
  }

  if (input.ciConclusion !== "SUCCESS") {
    return { stage: "awaiting_ci", blocker: `CI is ${input.ciConclusion ?? "pending"}.` };
  }

  if (
    input.scopeReviewConclusion === "FAILURE" ||
    input.scopeReviewConclusion === "CANCELLED" ||
    input.scopeReviewConclusion === "TIMED_OUT"
  ) {
    return { stage: "failed", blocker: `Scope review failed (${input.scopeReviewConclusion}).` };
  }

  if (input.scopeReviewConclusion !== "SUCCESS") {
    return { stage: "awaiting_scope_review", blocker: `Scope review is ${input.scopeReviewConclusion ?? "pending"}.` };
  }

  if (!input.merged) {
    const labelBlock =
      input.labels.includes("no-automerge") || input.labels.includes("human-needed")
        ? " Issue or PR has no-automerge / human-needed."
        : "";
    return {
      stage: "awaiting_merge",
      blocker: `PR #${input.pull.number} is green but not merged yet.${labelBlock}`,
    };
  }

  return { stage: "awaiting_ship", blocker: null };
}

export function formatPipelineInspection(inspection: PipelineInspection): string {
  const lines = [
    `**#${inspection.issueNumber}** — ${inspection.stageLabel}`,
    inspection.blocker ? `**Blocker:** ${inspection.blocker}` : "**Blocker:** none",
    "",
    "| Step | Status | Detail |",
    "| --- | --- | --- |",
  ];

  for (const item of inspection.checklist) {
    const icon =
      item.status === "done" ? "✅" : item.status === "failed" ? "❌" : item.status === "warn" ? "⚠️" : "⏳";
    lines.push(`| ${item.step} | ${icon} | ${item.detail ?? ""} |`);
  }

  if (inspection.agentUrl) {
    lines.push("", `[Cursor agent](${inspection.agentUrl})`);
  }
  if (inspection.prUrl) {
    lines.push(`[Pull request](${inspection.prUrl})`);
  }
  lines.push(`[GitHub issue](${inspection.issueUrl})`);

  return lines.join("\n");
}
