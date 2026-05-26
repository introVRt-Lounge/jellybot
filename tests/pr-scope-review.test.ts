import { describe, expect, test } from "bun:test";
import {
  buildReviewPrompt,
  formatReviewComment,
  isDocsOnlyFastPath,
  parseScopeReviewVerdict,
  reviewGatePasses,
  truncateDiff,
} from "../src/pr-scope-review/reviewer.ts";

describe("parseScopeReviewVerdict", () => {
  test("parses a pass verdict", () => {
    const verdict = parseScopeReviewVerdict(
      JSON.stringify({
        verdict: "pass",
        scope_aligned: true,
        quality_acceptable: true,
        summary: "In scope clip fix.",
        strengths: ["Tests added"],
        issues: [],
      }),
    );
    expect(reviewGatePasses(verdict)).toBe(true);
  });

  test("blocks fail and needs_human", () => {
    expect(
      reviewGatePasses(
        parseScopeReviewVerdict(
          JSON.stringify({
            verdict: "fail",
            scope_aligned: false,
            quality_acceptable: false,
            summary: "Out of scope",
            strengths: [],
            issues: [{ severity: "critical", title: "Scope", detail: "Wrong product" }],
          }),
        ),
      ),
    ).toBe(false);
  });
});

describe("isDocsOnlyFastPath", () => {
  test("accepts docs and markdown only", () => {
    expect(isDocsOnlyFastPath(["docs/PRODUCT_SCOPE.md", "README.md"])).toBe(true);
  });

  test("rejects mixed code changes", () => {
    expect(isDocsOnlyFastPath(["docs/PRODUCT_SCOPE.md", "src/index.ts"])).toBe(false);
  });
});

describe("formatReviewComment", () => {
  test("includes verdict table", () => {
    const body = formatReviewComment({
      verdict: "pass",
      scope_aligned: true,
      quality_acceptable: true,
      summary: "Good",
      strengths: [],
      issues: [],
    });
    expect(body).toContain("Scope review — pass");
    expect(body).toContain("| `pass` |");
  });
});

describe("buildReviewPrompt", () => {
  test("includes scope doc and diff", () => {
    const prompt = buildReviewPrompt({
      scopeDoc: "MISSION: clips",
      prTitle: "feat: clip",
      prBody: "Fixes #1",
      issueBodies: ["issue body"],
      changedFiles: ["src/a.ts"],
      diff: "+code",
    });
    expect(prompt.system).toContain("jellybot scope");
    expect(prompt.user).toContain("MISSION: clips");
    expect(prompt.user).toContain("+code");
  });
});

describe("truncateDiff", () => {
  test("truncates very large diffs", () => {
    const out = truncateDiff("x".repeat(200), 50);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("truncated");
  });
});
