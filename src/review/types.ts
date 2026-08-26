import type { ReviewRecord } from "../domain/comments";
import type { CommentThread } from "../domain/comments";
import type { Snapshot } from "../domain/review";
import type {
  PreparedSnapshot,
  SnapshotPreflight,
  SnapshotReadSession,
} from "../jj/snapshotBuilder";
import type { ReviewSelection } from "../jj/types";

export interface ReviewReadSession extends SnapshotReadSession {
  selectLast(count: number, signal?: AbortSignal): Promise<ReviewSelection>;
  resolveSelection(
    storedChangeIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReviewSelection>;
}

export interface ReviewRepository {
  readonly repository: string;
  openReadSession(signal?: AbortSignal): Promise<ReviewReadSession>;
}

export interface ReviewCapture {
  preflight(
    selection: ReviewSelection,
    session: SnapshotReadSession,
    signal?: AbortSignal,
  ): Promise<SnapshotPreflight>;
  prepare(
    selection: ReviewSelection,
    session: SnapshotReadSession,
    preflight: SnapshotPreflight,
    options: {
      readonly snapshotId: string;
      readonly capturedAt: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<PreparedSnapshot>;
}

export interface CommentProjectionContext {
  readonly previous: ReviewRecord;
  readonly nextSnapshot: Snapshot;
  readonly defaultFileProjections: readonly CommentThread[];
}

export type CommentProjectionHook = (
  context: CommentProjectionContext,
) => readonly CommentThread[] | Promise<readonly CommentThread[]>;

export type ReviewChangeType =
  | "started"
  | "refreshed"
  | "archived"
  | "restored"
  | "renamed"
  | "deleted";

export interface ReviewChangeEvent {
  readonly type: ReviewChangeType;
  readonly repositoryFingerprint: string;
  readonly reviewId: string;
  readonly snapshotId?: string;
}

export interface ReviewSubscription {
  dispose(): void;
}

export interface ReviewMutationOptions {
  readonly signal?: AbortSignal;
  readonly expectedCurrentSnapshotId?: string;
}
