export type ReviewIssue = {
  severity: "critical" | "important" | "minor";
  title: string;
  detail: string;
  path?: string;
};

export type ScopeReviewVerdict = {
  verdict: "pass" | "fail" | "needs_human";
  scope_aligned: boolean;
  quality_acceptable: boolean;
  summary: string;
  strengths: string[];
  issues: ReviewIssue[];
};

export function parseScopeReviewVerdict(raw: string): ScopeReviewVerdict {
  const parsed = JSON.parse(raw) as Partial<ScopeReviewVerdict>;
  const verdict = parsed.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "needs_human") {
    throw new Error(`Invalid verdict: ${String(verdict)}`);
  }

  return {
    verdict,
    scope_aligned: Boolean(parsed.scope_aligned),
    quality_acceptable: Boolean(parsed.quality_acceptable),
    summary: String(parsed.summary ?? "").trim() || "No summary provided.",
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.map((issue) => ({
          severity: issue?.severity === "critical" || issue?.severity === "important" ? issue.severity : "minor",
          title: String(issue?.title ?? "Issue"),
          detail: String(issue?.detail ?? ""),
          path: issue?.path ? String(issue.path) : undefined,
        }))
      : [],
  };
}

export function hasCriticalIssues(verdict: ScopeReviewVerdict): boolean {
  return verdict.issues.some((issue) => issue.severity === "critical");
}

export function reviewGatePasses(verdict: ScopeReviewVerdict): boolean {
  if (verdict.verdict === "pass") return true;
  if (verdict.verdict === "fail" || verdict.verdict === "needs_human") return false;
  return verdict.scope_aligned && verdict.quality_acceptable && !hasCriticalIssues(verdict);
}

/** Docs-only PRs skip the LLM reviewer (still in mission; low risk). */
export function isDocsOnlyFastPath(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => {
    if (file.startsWith("docs/")) return true;
    if (file.endsWith(".md")) return true;
    if (file === "LICENSE" || file === "CHANGELOG.md" || file === "CODE_OF_CONDUCT.md") return true;
    return false;
  });
}

export function buildReviewPrompt(input: {
  scopeDoc: string;
  prTitle: string;
  prBody: string;
  issueBodies: string[];
  changedFiles: string[];
  diff: string;
}): { system: string; user: string } {
  const issuesBlock =
    input.issueBodies.length > 0
      ? input.issueBodies.map((body, index) => `### Linked issue ${index + 1}\n${body}`).join("\n\n")
      : "(no linked issues parsed from PR body)";

  const system = `You are the jellybot scope and quality reviewer for GitHub pull requests.

Your job: decide if a PR should merge automatically — aligned with PRODUCT_SCOPE and acceptable engineering quality.

Respond with JSON only (no markdown fences) matching this schema:
{
  "verdict": "pass" | "fail" | "needs_human",
  "scope_aligned": boolean,
  "quality_acceptable": boolean,
  "summary": "one paragraph",
  "strengths": ["..."],
  "issues": [{"severity":"critical"|"important"|"minor","title":"...","detail":"...","path":"optional/file.ts"}]
}

Rules:
- verdict "pass" only if in scope AND no critical issues AND quality is acceptable for production.
- verdict "fail" for clear scope creep, critical bugs, missing tests on risky logic, or secrets risk.
- verdict "needs_human" for ambiguous scope, large refactors, or tradeoffs requiring operator judgment.
- Be specific; cite file paths when possible.
- CI/devops changes are in scope when they serve jellybot delivery.
- Do not nitpick formatting unless it hides a real bug.`;

  const user = `# PRODUCT_SCOPE

${input.scopeDoc}

# Pull request

**Title:** ${input.prTitle}

**Body:**
${input.prBody || "(empty)"}

${issuesBlock}

**Changed files:**
${input.changedFiles.map((f) => `- ${f}`).join("\n")}

# Diff (truncated if large)

\`\`\`diff
${input.diff}
\`\`\``;

  return { system, user };
}

export function formatReviewComment(verdict: ScopeReviewVerdict, opts: { fastPath?: boolean } = {}): string {
  const header = opts.fastPath
    ? "## Scope review — pass (docs-only fast path)\n"
    : `## Scope review — ${verdict.verdict === "pass" ? "pass" : "blocked"}\n`;

  const lines = [
    header,
    verdict.summary,
    "",
    `| Scope aligned | Quality OK | Verdict |`,
    `| --- | --- | --- |`,
    `| ${verdict.scope_aligned ? "yes" : "no"} | ${verdict.quality_acceptable ? "yes" : "no"} | \`${verdict.verdict}\` |`,
  ];

  if (verdict.strengths.length > 0) {
    lines.push("", "### Strengths", ...verdict.strengths.map((s) => `- ${s}`));
  }

  if (verdict.issues.length > 0) {
    lines.push("", "### Issues");
    for (const issue of verdict.issues) {
      const where = issue.path ? ` (\`${issue.path}\`)` : "";
      lines.push(`- **${issue.severity}** — ${issue.title}${where}: ${issue.detail}`);
    }
  }

  lines.push("", "_Automated review for auto-merge gate (`scope-review`). Label `scope-review-skip` to bypass._");
  return lines.join("\n");
}

export async function callOpenAiScopeReview(
  apiKey: string,
  prompt: { system: string; user: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ScopeReviewVerdict> {
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI returned empty review content");
  }

  return parseScopeReviewVerdict(content);
}

export function truncateDiff(diff: string, maxChars = 120_000): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}\n\n... [diff truncated at ${maxChars} chars for review] ...`;
}
