export type ClipPreviewState = "awaiting_approval" | "posted" | "cancelled";

export type ClipPreviewAction = "post" | "cancel" | "retry";

export type ClipPreviewTransitionResult =
  | { ok: true; state: ClipPreviewState }
  | { ok: false; message: string };

export function canApplyPreviewAction(state: ClipPreviewState, action: ClipPreviewAction): boolean {
  if (state !== "awaiting_approval") {
    return false;
  }
  return action === "post" || action === "cancel" || action === "retry";
}

export function applyPreviewAction(
  state: ClipPreviewState,
  action: ClipPreviewAction,
): ClipPreviewTransitionResult {
  if (!canApplyPreviewAction(state, action)) {
    return {
      ok: false,
      message:
        state === "posted"
          ? "That clip was already posted."
          : state === "cancelled"
            ? "That preview was cancelled."
            : "That preview is no longer available.",
    };
  }

  if (action === "post") {
    return { ok: true, state: "posted" };
  }

  if (action === "cancel") {
    return { ok: true, state: "cancelled" };
  }

  return { ok: true, state: "awaiting_approval" };
}
