import { describe, expect, test } from "bun:test";
import { parseAgentIdFromText } from "../src/features/pipeline-stages.ts";
import { formatPipelineInspection, type PipelineInspection } from "../src/features/pipeline-tracker.ts";

describe("pipeline-stages", () => {
  test("parseAgentIdFromText reads marker comment", () => {
    const body = "<!-- jellybot-pipeline-agent-id: bc-abc-123 -->\nAgent started.";
    expect(parseAgentIdFromText(body)).toBe("bc-abc-123");
  });
});

describe("formatPipelineInspection", () => {
  test("includes blocker and checklist rows", () => {
    const inspection: PipelineInspection = {
      issueNumber: 82,
      issueTitle: "Subtitle coverage",
      issueUrl: "https://github.com/example/issues/82",
      issueState: "closed",
      stage: "awaiting_pr",
      stageLabel: "Waiting for PR",
      blocker: "Branch exists but no PR.",
      branchName: "ai-triage/fix-issue-82",
      branchExists: true,
      prNumber: null,
      prState: null,
      prUrl: null,
      ciConclusion: null,
      scopeReviewConclusion: null,
      labels: ["discord-triage-blessed", "ai-triage-enqueued"],
      agentId: "bc-test",
      agentUrl: "https://cursor.com/agents?id=bc-test",
      merged: false,
      checklist: [
        { step: "Pull request opened", status: "failed", detail: "Branch exists but no PR" },
      ],
    };

    const text = formatPipelineInspection(inspection);
    expect(text).toContain("Waiting for PR");
    expect(text).toContain("Branch exists but no PR.");
    expect(text).toContain("cursor.com/agents");
  });
});
