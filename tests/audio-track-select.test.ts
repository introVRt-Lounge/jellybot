import { describe, expect, test } from "bun:test";
import { pickAudioStream } from "../src/audio-track-select.ts";

describe("pickAudioStream", () => {
  test("prefers English over Jellyfin default foreign track", () => {
    const picked = pickAudioStream(
      [
        { type: "Audio", index: 2, language: "tur", isDefault: true },
        { type: "Audio", index: 3, language: "eng", isDefault: false },
      ],
      ["eng", "en"],
    );

    expect(picked?.index).toBe(3);
    expect(picked?.language).toBe("eng");
  });

  test("matches regional English tags such as en-US", () => {
    const picked = pickAudioStream(
      [
        { type: "Audio", index: 1, language: "deu", isDefault: true },
        { type: "Audio", index: 2, language: "en-US", isDefault: false },
      ],
      ["eng"],
    );

    expect(picked?.index).toBe(2);
  });

  test("falls back to default when no preferred language exists", () => {
    const picked = pickAudioStream([{ type: "Audio", index: 1, language: "jpn", isDefault: true }], ["eng"]);
    expect(picked?.language).toBe("jpn");
  });
});
