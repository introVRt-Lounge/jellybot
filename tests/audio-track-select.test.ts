import { describe, expect, test } from "bun:test";
import {
  audioStreamOrdinal,
  isCommentaryAudioTrack,
  pickAudioStream,
} from "../src/audio-track-select.ts";

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

  test("never picks director commentary when a theatrical mix exists (#184)", () => {
    // Jerry Maguire shape: both tracks eng; commentary has a long Title.
    const picked = pickAudioStream(
      [
        {
          type: "Audio",
          index: 2,
          language: "eng",
          isDefault: true,
          channels: 6,
          displayTitle: "English - Dolby Digital - 5.1 - Default",
        },
        {
          type: "Audio",
          index: 3,
          language: "eng",
          isDefault: false,
          channels: 2,
          title:
            "Commentary by Director/Writer/Producer Cameron Crowe, and Stars Renee Zellweger, Tom Cruise and Cuba Gooding Jr.",
        },
      ],
      ["eng", "en"],
    );

    expect(picked?.index).toBe(2);
    expect(isCommentaryAudioTrack(picked!)).toBe(false);
  });

  test("skips commentary even when it is marked default", () => {
    const picked = pickAudioStream(
      [
        {
          type: "Audio",
          index: 1,
          language: "eng",
          isDefault: true,
          title: "Director's Commentary",
          channels: 2,
        },
        {
          type: "Audio",
          index: 2,
          language: "eng",
          isDefault: false,
          channels: 6,
          title: "",
        },
      ],
      ["eng"],
    );

    expect(picked?.index).toBe(2);
  });
});

describe("audioStreamOrdinal (#184)", () => {
  test("maps Jellyfin audio index to 0-based audio ordinal", () => {
    const streams = [
      { type: "Video", index: 0 },
      { type: "Audio", index: 2, language: "eng" },
      { type: "Audio", index: 3, language: "eng", title: "Commentary" },
      { type: "Subtitle", index: 4 },
    ];

    expect(audioStreamOrdinal(streams, 2)).toBe(0);
    expect(audioStreamOrdinal(streams, 3)).toBe(1);
    expect(audioStreamOrdinal(streams, 99)).toBeNull();
  });
});

describe("isCommentaryAudioTrack", () => {
  test("detects common commentary title patterns", () => {
    expect(isCommentaryAudioTrack({ title: "Commentary by the Director" })).toBe(true);
    expect(isCommentaryAudioTrack({ displayTitle: "English - Audio Commentary" })).toBe(true);
    expect(isCommentaryAudioTrack({ title: "English", displayTitle: "English - 5.1 - Default" })).toBe(false);
  });
});
