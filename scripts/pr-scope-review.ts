#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReviewPrompt,
  callOpenAiScopeReview,
  formatReviewComment,
  isDocsOnlyFastPath,
  reviewGatePasses,
  truncateDiff,
  type ScopeReviewVerdict,
} from "../src/pr-scope-review/reviewer.ts";

const REPOSITORY = process.env.REPOSITORY ?? "";
const PR_NUMBER = process.env.PR_NUMBER ?? "";
const GH_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

function requireEnv(name: string, value: string): string {
  if (!value.trim()) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    env: { ...process.env, GH_TOKEN, GITHUB_TOKEN: GH_TOKEN },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr || stdout}`);
  }
  return stdout;
}

function parseLinkedIssueNumbers(body: string): number[] {
  const matches = body.matchAll(/(?:Fixes|Closes|fixes|closes)\s+#(\d+)/g);
  return [...new Set([...matches].map((m) => Number(m[1])))].filter((n) => Number.isFinite(n));
}

function labelsInclude(labels: string[], name: string): boolean {
  return labels.some((label) => label === name);
}

async function main(): Promise<void> {
  const repo = requireEnv("REPOSITORY", REPOSITORY);
  const prNumber = requireEnv("PR_NUMBER", PR_NUMBER);
  requireEnv("GH_TOKEN", GH_TOKEN);

  const prJson = JSON.parse(
    await gh([
      "pr",
      "view",
      prNumber,
      "--repo",
      repo,
      "--json",
      "title,body,labels,headRefOid,baseRefOid",
    ]),
  ) as {
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    headRefOid: string;
    baseRefOid: string;
  };

  const prLabels = prJson.labels.map((label) => label.name);
  if (labelsInclude(prLabels, "scope-review-skip") || labelsInclude(prLabels, "no-automerge") || labelsInclude(prLabels, "human-needed")) {
    console.info("Skipping scope review due to opt-out label on PR.");
    await gh(["pr", "comment", prNumber, "--repo", repo, "--body", "## Scope review — skipped\nOpt-out label on PR."]);
    return;
  }

  const issueNumbers = parseLinkedIssueNumbers(prJson.body ?? "");
  for (const issueNum of issueNumbers) {
    const issueLabels = (
      await gh(["issue", "view", String(issueNum), "--repo", repo, "--json", "labels", "-q", ".labels[].name"])
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (labelsInclude(issueLabels, "scope-review-skip") || labelsInclude(issueLabels, "human-needed") || labelsInclude(issueLabels, "no-automerge")) {
      console.info(`Skipping scope review due to opt-out label on issue #${issueNum}.`);
      await gh([
        "pr",
        "comment",
        prNumber,
        "--repo",
        repo,
        "--body",
        `## Scope review — skipped\nOpt-out label on linked issue #${issueNum}.`,
      ]);
      return;
    }
  }

  const filesRaw = JSON.parse(
    await gh(["api", `/repos/${repo}/pulls/${prNumber}/files`, "--paginate"]),
  ) as Array<{ filename: string }>;
  const changedFiles = filesRaw.map((file) => file.filename);

  const scopeDoc = readFileSync(join(process.cwd(), "docs/PRODUCT_SCOPE.md"), "utf8");
  let verdict: ScopeReviewVerdict;
  let fastPath = false;

  if (isDocsOnlyFastPath(changedFiles)) {
    fastPath = true;
    verdict = {
      verdict: "pass",
      scope_aligned: true,
      quality_acceptable: true,
      summary: "Documentation-only change; fast-path pass without LLM review.",
      strengths: ["Docs-only diff"],
      issues: [],
    };
  } else {
    requireEnv("OPENAI_API_KEY", OPENAI_API_KEY);
    const diff = truncateDiff(
      await gh(["pr", "diff", prNumber, "--repo", repo]),
    );
    const issueBodies: string[] = [];
    for (const issueNum of issueNumbers) {
      const body = await gh(["issue", "view", String(issueNum), "--repo", repo, "--json", "body", "-q", ".body"]);
      issueBodies.push(body || "(no body)");
    }

    const prompt = buildReviewPrompt({
      scopeDoc,
      prTitle: prJson.title,
      prBody: prJson.body ?? "",
      issueBodies,
      changedFiles,
      diff,
    });
    verdict = await callOpenAiScopeReview(OPENAI_API_KEY, prompt);
  }

  const comment = formatReviewComment(verdict, { fastPath });
  await gh(["pr", "comment", prNumber, "--repo", repo, "--body", comment]);

  console.info(JSON.stringify({ event: "scope_review.completed", verdict: verdict.verdict, fastPath }));

  if (!reviewGatePasses(verdict)) {
    console.error(`Scope review blocked merge: ${verdict.summary}`);
    process.exit(1);
  }
}

await main();
