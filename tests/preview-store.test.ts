import { describe, expect, test } from "bun:test";
import { PreviewStore } from "../src/api/preview-store.ts";

describe("PreviewStore", () => {
  test("stores and retrieves previews before expiry", () => {
    const store = new PreviewStore(60_000);
    const record = store.put({
      id: "abc",
      filePath: "/tmp/not-real.mp4",
      fileName: "clip.mp4",
      contentType: "video/mp4",
    });

    expect(record.expiresAt).toBeGreaterThan(Date.now());
    expect(store.get("abc")?.fileName).toBe("clip.mp4");
  });

  test("expires missing previews", () => {
    const store = new PreviewStore(1);
    store.put({
      id: "gone",
      filePath: "/tmp/not-real.mp4",
      fileName: "clip.mp4",
      contentType: "video/mp4",
    });

    const expiresAt = store.get("gone")!.expiresAt;
    expect(store.get("gone")).not.toBeNull();
    const originalNow = Date.now;
    Date.now = () => expiresAt + 10;
    expect(store.get("gone")).toBeNull();
    Date.now = originalNow;
  });
});
