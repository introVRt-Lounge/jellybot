import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotStateStore } from "../src/release/bot-state.ts";

describe("BotStateStore", () => {
  test("returns null until a release is recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "jellybot-bot-state-"));
    const dbPath = join(dir, "bot-state.db");
    try {
      const store = new BotStateStore(dbPath);
      expect(store.getLastAnnouncedRelease()).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists the latest announced tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "jellybot-bot-state-"));
    const dbPath = join(dir, "bot-state.db");
    try {
      const store = new BotStateStore(dbPath);
      store.setLastAnnouncedRelease("v1.0.0");
      store.setLastAnnouncedRelease("v1.1.0");
      expect(store.getLastAnnouncedRelease()).toBe("v1.1.0");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
