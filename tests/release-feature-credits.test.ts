import { describe, expect, test } from "bun:test";
import {
  findPreviousReleaseTag,
  formatFeatureCredits,
  formatGitHubPerson,
  parseFeatureSummary,
  parsePullRequestNumber,
} from "../src/release/release-feature-credits.ts";

describe("release feature credits", () => {
  test("parseFeatureSummary extracts feat subject", () => {
    expect(parseFeatureSummary("feat(clip): ephemeral preview before posting (#49)")).toBe(
      "ephemeral preview before posting",
    );
    expect(parseFeatureSummary("fix: nothing")).toBeNull();
  });

  test("parsePullRequestNumber reads trailing PR reference", () => {
    expect(parsePullRequestNumber("feat(ci): auto-merge ai-safe PRs (#51)")).toBe(51);
    expect(parsePullRequestNumber("feat: no pr ref")).toBeNull();
  });

  test("findPreviousReleaseTag picks the next older release", () => {
    const tags = ["v1.2.0", "v1.1.0", "v1.0.0"];
    expect(findPreviousReleaseTag("v1.2.0", tags)).toBe("v1.1.0");
    expect(findPreviousReleaseTag("v1.0.0", tags)).toBeNull();
  });

  test("formatGitHubPerson prefers GitHub display name", () => {
    expect(formatGitHubPerson("HeavyGee", "heavygee")).toBe("HeavyGee (@heavygee)");
    expect(formatGitHubPerson("heavygee", "heavygee")).toBe("@heavygee");
  });

  test("formatGitHubPerson pings mapped lounge members", () => {
    expect(formatGitHubPerson("Gavin", "Gpcas9")).toContain("<@385136311927046154>");
  });

  test("formatFeatureCredits renders bullet list", () => {
    const formatted = formatFeatureCredits([
      { summary: "clip preview", login: "heavygee", displayName: "HeavyGee" },
      { summary: "auto-merge", login: "heavygee", displayName: "HeavyGee" },
    ]);
    expect(formatted).toContain("- clip preview — HeavyGee (@heavygee)");
    expect(formatted).toContain("- auto-merge — HeavyGee (@heavygee)");
  });
});
