import { describe, expect, test } from "bun:test";
import {
  previewButtonCustomId,
  previewModalCustomId,
  parsePreviewButtonCustomId,
  parsePreviewModalCustomId,
  isPreviewInteractionCustomId,
} from "../src/clip-preview/custom-id.ts";
import { applyPreviewAction, canApplyPreviewAction } from "../src/clip-preview/state-machine.ts";
import { ClipPreviewStore } from "../src/clip-preview/store.ts";

describe("clip preview state machine", () => {
  test("allows post, cancel, and retry while awaiting approval", () => {
    expect(canApplyPreviewAction("awaiting_approval", "post")).toBe(true);
    expect(canApplyPreviewAction("awaiting_approval", "cancel")).toBe(true);
    expect(canApplyPreviewAction("awaiting_approval", "retry")).toBe(true);
  });

  test("rejects actions after post or cancel", () => {
    expect(canApplyPreviewAction("posted", "post")).toBe(false);
    expect(canApplyPreviewAction("cancelled", "cancel")).toBe(false);
    expect(applyPreviewAction("posted", "post").ok).toBe(false);
    expect(applyPreviewAction("cancelled", "cancel").ok).toBe(false);
  });

  test("post and cancel reach terminal states", () => {
    expect(applyPreviewAction("awaiting_approval", "post")).toEqual({ ok: true, state: "posted" });
    expect(applyPreviewAction("awaiting_approval", "cancel")).toEqual({ ok: true, state: "cancelled" });
  });

  test("retry keeps awaiting approval", () => {
    expect(applyPreviewAction("awaiting_approval", "retry")).toEqual({ ok: true, state: "awaiting_approval" });
  });
});

describe("clip preview custom ids", () => {
  const sessionId = "abc-123";

  test("round-trips button and modal ids", () => {
    expect(parsePreviewButtonCustomId(previewButtonCustomId("post", sessionId))).toEqual({
      action: "post",
      sessionId,
    });
    expect(parsePreviewModalCustomId(previewModalCustomId(sessionId))).toEqual({ sessionId });
    expect(isPreviewInteractionCustomId(previewButtonCustomId("retry", sessionId))).toBe(true);
  });

  test("rejects unknown custom ids", () => {
    expect(parsePreviewButtonCustomId("clip:post:abc")).toBeNull();
    expect(parsePreviewModalCustomId("other:modal:abc")).toBeNull();
  });
});

describe("ClipPreviewStore", () => {
  test("expires sessions after ttl", async () => {
    const store = new ClipPreviewStore(10);
    store.create({
      id: "sess-1",
      ownerUserId: "user-1",
      channelId: "chan-1",
      command: "clip",
      outputPath: "/tmp/x.mp4",
      attachmentName: "x.mp4",
      label: "Test",
      previewLines: ["line"],
    });

    expect(store.get("sess-1")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.get("sess-1")).toBeUndefined();
  });
});
