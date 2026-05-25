import { describe, expect, test } from "bun:test";
import { isMajorOrMinorRelease, isPatchRelease, looksLikeReleaseTag, parseReleaseVersion } from "../src/release/semver.ts";

describe("release semver helpers", () => {
  test("parses semver tags with optional v prefix", () => {
    expect(parseReleaseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseReleaseVersion("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  test("treats two-part versions as patch zero", () => {
    expect(parseReleaseVersion("v1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(isPatchRelease("v1.2")).toBe(false);
  });

  test("identifies patch releases", () => {
    expect(isPatchRelease("v1.0.1")).toBe(true);
    expect(isPatchRelease("v1.0.0")).toBe(false);
    expect(isPatchRelease("v2.1.0")).toBe(false);
  });

  test("identifies major/minor releases", () => {
    expect(isMajorOrMinorRelease("v1.0.0")).toBe(true);
    expect(isMajorOrMinorRelease("v1.2.0")).toBe(true);
    expect(isMajorOrMinorRelease("v1.2.3")).toBe(false);
  });

  test("rejects invalid tags", () => {
    expect(parseReleaseVersion("")).toBeNull();
    expect(parseReleaseVersion("not-a-version")).toBeNull();
    expect(looksLikeReleaseTag("dev")).toBe(false);
    expect(looksLikeReleaseTag("v1.0.0")).toBe(true);
  });
});
