export class AutocompleteSessionGuard {
  private readonly generation = new Map<string, number>();

  begin(key: string): () => boolean {
    const next = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, next);
    return () => this.generation.get(key) === next;
  }
}

export function isUnknownInteractionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Unknown interaction");
}
