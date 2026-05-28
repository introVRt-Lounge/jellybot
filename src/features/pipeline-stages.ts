export type PipelineStepStatus = "done" | "pending" | "failed" | "warn";

export type PipelineChecklistItem = {
  step: string;
  status: PipelineStepStatus;
  detail?: string;
};

export type PipelineStageId =
  | "not_blessed"
  | "awaiting_enqueue"
  | "awaiting_agent"
  | "awaiting_branch"
  | "awaiting_pr"
  | "awaiting_ci"
  | "awaiting_scope_review"
  | "awaiting_merge"
  | "awaiting_ship"
  | "shipped"
  | "failed";

export const PIPELINE_STAGE_LABELS: Record<PipelineStageId, string> = {
  not_blessed: "Not blessed",
  awaiting_enqueue: "Waiting for triage enqueue",
  awaiting_agent: "Waiting for Cursor agent",
  awaiting_branch: "Waiting for agent branch push",
  awaiting_pr: "Waiting for PR",
  awaiting_ci: "Waiting for CI",
  awaiting_scope_review: "Waiting for scope review",
  awaiting_merge: "Waiting for merge",
  awaiting_ship: "Waiting for ship / deploy",
  shipped: "Shipped",
  failed: "Failed",
};

export function branchNameForIssue(issueNumber: number): string {
  return `ai-triage/fix-issue-${issueNumber}`;
}

export const PIPELINE_AGENT_ID_MARKER = "jellybot-pipeline-agent-id:";

export function parseAgentIdFromText(text: string): string | null {
  const match = text.match(/jellybot-pipeline-agent-id:\s*([a-zA-Z0-9-]+)/);
  return match?.[1] ?? null;
}
