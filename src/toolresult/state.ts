export class ContentReplacementState {
  readonly #seenIds = new Set<string>();
  readonly #replacements = new Map<string, string>();

  record(toolUseId: string, original: string, replaced: string): void {
    this.#seenIds.add(toolUseId);
    if (original !== replaced) this.#replacements.set(toolUseId, replaced);
  }

  has(toolUseId: string): boolean {
    return this.#seenIds.has(toolUseId);
  }

  getReplacement(toolUseId: string): string | undefined {
    return this.#replacements.get(toolUseId);
  }

  clone(): ContentReplacementState {
    const copy = new ContentReplacementState();
    for (const id of this.#seenIds) copy.#seenIds.add(id);
    for (const [id, value] of this.#replacements) copy.#replacements.set(id, value);
    return copy;
  }

  size(): number {
    return this.#seenIds.size;
  }
}
