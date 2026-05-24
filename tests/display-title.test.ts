import { describe, expect, test } from "bun:test";
import { displayTitle, displayTitleWithYear, looksLikeReleaseFilename } from "../src/display-title.ts";

describe("looksLikeReleaseFilename", () => {
  test("detects scene-style movie filenames", () => {
    expect(looksLikeReleaseFilename("Grumpy.Old.Men.1993.1080p.BluRay.x265-RARBG")).toBe(true);
    expect(looksLikeReleaseFilename("Grumpy Old Men")).toBe(false);
  });
});

describe("displayTitle", () => {
  test("prefers original title for misnamed movies", () => {
    expect(
      displayTitle({
        name: "Grumpy.Old.Men.1993.1080p.BluRay.x265-RARBG",
        originalTitle: "Grumpy Old Men",
        type: "Movie",
      }),
    ).toBe("Grumpy Old Men");
  });

  test("keeps clean names when original title matches", () => {
    expect(
      displayTitle({
        name: "The Matrix",
        originalTitle: "The Matrix",
        type: "Movie",
      }),
    ).toBe("The Matrix");
  });

  test("adds year for compact labels", () => {
    expect(
      displayTitleWithYear({
        name: "Grumpy.Old.Men.1993.1080p.BluRay.x265-RARBG",
        originalTitle: "Grumpy Old Men",
        type: "Movie",
        productionYear: 1993,
      }),
    ).toBe("Grumpy Old Men (1993)");
  });
});
