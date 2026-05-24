import { describe, expect, test } from "bun:test";
import { parseTimestamp, formatTimestamp } from "../src/time.ts";

describe("parseTimestamp", () => {
  test("accepts common formats", () => {
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("1:30")).toBe(90);
    expect(parseTimestamp("01:02:03")).toBe(3723);
    expect(parseTimestamp("30s")).toBe(30);
  });

  test("rejects invalid input", () => {
    expect(() => parseTimestamp("nope")).toThrow(/Invalid timestamp/);
  });
});

describe("formatTimestamp", () => {
  test("formats sub-hour and hour values", () => {
    expect(formatTimestamp(90)).toBe("1:30");
    expect(formatTimestamp(3723)).toBe("1:02:03");
  });
});
