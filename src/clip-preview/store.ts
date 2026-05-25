import type { ClipPreviewState } from "./state-machine.ts";

export type ClipPreviewCommand = "clip" | "quote";

export type ClipPreviewClipParams = {
  kind: "movie" | "tv";
  itemId: string;
  startRaw: string;
  endRaw: string | null;
  durationRaw: string | null;
  burnInSubtitles: boolean;
};

export type ClipPreviewQuoteParams = {
  matchRaw: string;
  durationRaw: string | null;
  paddingRaw: string | null;
  burnInSubtitles: boolean;
};

export type ClipPreviewSession = {
  id: string;
  ownerUserId: string;
  channelId: string;
  command: ClipPreviewCommand;
  state: ClipPreviewState;
  outputPath: string;
  attachmentName: string;
  label: string;
  previewLines: string[];
  clipParams?: ClipPreviewClipParams;
  quoteParams?: ClipPreviewQuoteParams;
  createdAt: number;
};

const DEFAULT_TTL_MS = 14 * 60 * 1000;

export class ClipPreviewStore {
  private readonly sessions = new Map<string, ClipPreviewSession>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  create(session: Omit<ClipPreviewSession, "createdAt" | "state">): ClipPreviewSession {
    this.purgeExpired();
    const record: ClipPreviewSession = {
      ...session,
      state: "awaiting_approval",
      createdAt: Date.now(),
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(sessionId: string): ClipPreviewSession | undefined {
    this.purgeExpired();
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  updateState(sessionId: string, state: ClipPreviewState): ClipPreviewSession | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;
    session.state = state;
    this.sessions.set(sessionId, session);
    return session;
  }

  updateArtifact(
    sessionId: string,
    artifact: Pick<ClipPreviewSession, "outputPath" | "attachmentName" | "label" | "previewLines">,
  ): ClipPreviewSession | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;
    Object.assign(session, artifact);
    this.sessions.set(sessionId, session);
    return session;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private isExpired(session: ClipPreviewSession): boolean {
    return Date.now() - session.createdAt > this.ttlMs;
  }

  private purgeExpired(): void {
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(id);
      }
    }
  }
}

export const clipPreviewStore = new ClipPreviewStore();
