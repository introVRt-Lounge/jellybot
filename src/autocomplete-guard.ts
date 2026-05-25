export class AutocompleteSessionGuard {
  private readonly generation = new Map<string, number>();
  private readonly abortControllers = new Map<string, AbortController>();

  begin(key: string): () => boolean {
    return this.beginCancellable(key).isCurrent;
  }

  beginCancellable(key: string): { isCurrent: () => boolean; signal: AbortSignal } {
    this.abortControllers.get(key)?.abort();

    const next = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, next);

    const controller = new AbortController();
    this.abortControllers.set(key, controller);

    return {
      isCurrent: () => this.generation.get(key) === next,
      signal: controller.signal,
    };
  }
}

export function isUnknownInteractionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Unknown interaction");
}

export function isInteractionAcknowledgedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("Interaction has already been acknowledged")) return true;
  const code = (error as { code?: number }).code;
  return code === 40060;
}

export function isBenignAutocompleteError(error: unknown): boolean {
  return isUnknownInteractionError(error) || isInteractionAcknowledgedError(error) || isAbortError(error);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
