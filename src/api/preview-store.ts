import { unlink } from "node:fs/promises";

export type PreviewRecord = {
  id: string;
  filePath: string;
  fileName: string;
  contentType: string;
  expiresAt: number;
};

export class PreviewStore {
  private records = new Map<string, PreviewRecord>();

  constructor(private ttlMs: number) {}

  put(input: Omit<PreviewRecord, "expiresAt">): PreviewRecord {
    this.evictExpired();
    const record: PreviewRecord = {
      ...input,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): PreviewRecord | null {
    this.evictExpired();
    const record = this.records.get(id);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      void this.remove(id);
      return null;
    }
    return record;
  }

  async remove(id: string): Promise<void> {
    const record = this.records.get(id);
    this.records.delete(id);
    if (!record) return;
    await unlink(record.filePath).catch(() => undefined);
  }

  size(): number {
    this.evictExpired();
    return this.records.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (now > record.expiresAt) {
        void this.remove(id);
      }
    }
  }
}
