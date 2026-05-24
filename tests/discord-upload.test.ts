import { describe, expect, test } from "bun:test";
import { maxClipMbForDiscordUpload } from "../src/discord-upload.ts";

describe("maxClipMbForDiscordUpload", () => {
  test("uses Discord attachment limit with safety margin", () => {
    const tenMb = 10 * 1024 * 1024;
    expect(maxClipMbForDiscordUpload(tenMb, 24)).toBeCloseTo(9.5, 1);
  });

  test("respects configured ceiling", () => {
    const fiftyMb = 50 * 1024 * 1024;
    expect(maxClipMbForDiscordUpload(fiftyMb, 9)).toBe(9);
  });
});
