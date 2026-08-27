import { describe, expect, test } from "bun:test";
import {
  formatDmcaNtfyPayload,
  isDmcaHoneypot,
  parseDmcaReportBody,
} from "../src/api/dmca-report.ts";

describe("parseDmcaReportBody", () => {
  test("requires core fields and attestations", () => {
    expect(parseDmcaReportBody({}).ok).toBe(false);
    expect(
      parseDmcaReportBody({
        name: "Ada",
        email: "ada@example.com",
        copyrightedWork: "Example Movie",
        infringingMaterial: "Preview clip",
        goodFaith: true,
        accuracy: true,
      }).ok,
    ).toBe(true);
  });

  test("treats honeypot submissions as silently ok", () => {
    const parsed = parseDmcaReportBody({
      name: "Bot",
      email: "bot@example.com",
      copyrightedWork: "x",
      infringingMaterial: "y",
      goodFaith: true,
      accuracy: true,
      website: "http://spam.example",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isDmcaHoneypot(parsed.report)).toBe(true);
    }
  });

  test("formats ntfy payload with preview url", () => {
    const parsed = parseDmcaReportBody({
      name: "Rights Holder",
      email: "holder@example.com",
      copyrightedWork: "Demo Movie (2020)",
      infringingMaterial: "Quote match for hello world",
      previewUrl: "https://api.jellybot.introvrtlounge.com/api/v1/previews/abc",
      goodFaith: true,
      accuracy: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const payload = formatDmcaNtfyPayload(parsed.report, "203.0.113.10");
    expect(payload).toContain("Demo Movie (2020)");
    expect(payload).toContain("previews/abc");
    expect(payload).toContain("203.0.113.10");
  });
});
