import { describe, expect, test } from "bun:test";
import { pickSubtitleStream } from "../src/subtitles/track-select.ts";

describe("pickSubtitleStream", () => {
  test("prefers english default over forced foreign track", () => {
    const picked = pickSubtitleStream(
      [
        { type: "Subtitle", index: 1, language: "spa", isForced: true, isTextSubtitleStream: true },
        { type: "Subtitle", index: 2, language: "eng", isDefault: true, isTextSubtitleStream: true },
      ],
      ["eng", "en"],
    );

    expect(picked?.index).toBe(2);
  });

  test("returns null when no subtitle streams exist", () => {
    expect(pickSubtitleStream([{ type: "Audio", index: 0 }])).toBeNull();
  });
});
