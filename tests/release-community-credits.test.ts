import { describe, expect, test } from "bun:test";
import { discordMentionForGitHubLogin } from "../src/release/github-discord-members.ts";
import {
  formatCommunityCredits,
  formatGitHubPerson,
  parseLinkedIssueNumbers,
  parseReportedByLogin,
  summarizeIssueTitle,
} from "../src/release/release-community-credits.ts";

describe("github discord members", () => {
  test("mentions Gpcas9", () => {
    expect(discordMentionForGitHubLogin("Gpcas9")).toBe("<@385136311927046154>");
  });

  test("mentions are case-insensitive on login", () => {
    expect(discordMentionForGitHubLogin("TooManyPillows")).toBe("<@203729667595829248>");
  });
});

describe("release community credits", () => {
  test("parseLinkedIssueNumbers reads Fixes/Closes lines", () => {
    expect(parseLinkedIssueNumbers("Fixes #60\nCloses #66")).toEqual([60, 66]);
  });

  test("parseReportedByLogin reads issue reporter", () => {
    expect(parseReportedByLogin("## Reported by\n\n@Gpcas9 (YngwieAnders)")).toBe("Gpcas9");
  });

  test("summarizeIssueTitle strips issue prefix", () => {
    expect(summarizeIssueTitle("[feat]: Make /quote match required in Discord command schema")).toBe(
      "Make /quote match required in Discord command schema",
    );
  });

  test("formatGitHubPerson appends Discord mention when mapped", () => {
    expect(formatGitHubPerson("Gavin", "Gpcas9")).toBe("Gavin (@Gpcas9) <@385136311927046154>");
  });

  test("formatCommunityCredits renders reporter bullets", () => {
    const formatted = formatCommunityCredits([
      {
        summary: "Make /quote match required",
        login: "Gpcas9",
        displayName: "Gavin",
      },
    ]);
    expect(formatted).toContain("reported by Gavin (@Gpcas9) <@385136311927046154>");
  });
});
