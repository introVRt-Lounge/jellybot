/**
 * Short window during which background work (incremental subtitle indexing)
 * should yield so Discord slash/autocomplete handlers keep the 3s ack budget.
 */
let priorityUntilMs = 0;

/** Extend interactive priority (default 8s covers a burst of keystrokes). */
export function bumpInteractivePriority(durationMs = 8_000): void {
  priorityUntilMs = Math.max(priorityUntilMs, Date.now() + durationMs);
}

export function isInteractivePriorityActive(): boolean {
  return Date.now() < priorityUntilMs;
}

/** Wait until interactive priority expires (indexer calls between items). */
export async function waitForInteractivePriorityClear(pollMs = 50): Promise<void> {
  while (isInteractivePriorityActive()) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Test-only reset. */
export function resetInteractivePriorityForTests(): void {
  priorityUntilMs = 0;
}
