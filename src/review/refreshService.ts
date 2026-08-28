import type { CommentThread, ReviewRecord } from "../domain/comments";
import { parseReviewRecord } from "../domain/comments";
import type { FileManifestEntry, Snapshot, ViewIdentity } from "../domain/review";
import { viewIdentityKey } from "../domain/review";
import {
  preflightSnapshot,
  prepareSnapshot,
  shouldWarnForChangedLines,
} from "../jj/snapshotBuilder";
import type { ReviewSelection } from "../jj/types";
import type { ReviewStore } from "../storage/reviewStore";
import {
  ArchivedReviewReadOnlyError,
  LargeDiffConfirmationRequiredError,
  NoActiveReviewError,
  StaleReviewError,
} from "./errors";
import type {
  CommentProjectionHook,
  ReviewCapture,
  ReviewMutationOptions,
  ReviewReadSession,
  ReviewRepository,
} from "./types";
import { runRepositoryMutation } from "./mutationQueue";
import { projectCommentThreads } from "./commentProjection";

export interface RefreshReviewOptions extends ReviewMutationOptions {
  readonly confirmLargeDiff?: boolean;
}

export interface RefreshReviewResult {
  readonly record: ReviewRecord;
  readonly changed: boolean;
}

export interface IncludeNewChangesResult {
  readonly record: ReviewRecord;
  readonly addedChangeCount: number;
}

export interface RefreshServiceOptions {
  readonly store: ReviewStore;
  readonly repository: ReviewRepository;
  readonly warningLineCount?: number;
  readonly capture?: ReviewCapture;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  readonly projectComments?: CommentProjectionHook;
}

export const productionReviewCapture: ReviewCapture = {
  preflight: async (selection, session, signal) =>
    preflightSnapshot(
      selection,
      session,
      signal === undefined ? {} : { signal },
    ),
  prepare: async (selection, session, preflight, options) =>
    prepareSnapshot(selection, session, {
      preflight,
      snapshotId: options.snapshotId,
      capturedAt: options.capturedAt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
};

export class RefreshService {
  readonly #store: ReviewStore;
  readonly #repository: ReviewRepository;
  readonly #warningLineCount: number;
  readonly #capture: ReviewCapture;
  readonly #clock: () => Date;
  readonly #uuid: () => string;
  readonly #projectComments: CommentProjectionHook | undefined;

  public constructor(options: RefreshServiceOptions) {
    this.#store = options.store;
    this.#repository = options.repository;
    this.#warningLineCount = options.warningLineCount ?? 10_000;
    if (
      !Number.isSafeInteger(this.#warningLineCount) ||
      this.#warningLineCount < 0
    ) {
      throw new RangeError("The changed-line warning setting must be non-negative.");
    }
    this.#capture = options.capture ?? productionReviewCapture;
    this.#clock = options.clock ?? (() => new Date());
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#projectComments = options.projectComments ?? projectCommentThreads;
  }

  public async refreshActive(
    options: RefreshReviewOptions = {},
  ): Promise<RefreshReviewResult> {
    return runRepositoryMutation(this.#store.fingerprint, async () =>
      this.refreshActiveUnlocked(options),
    );
  }

  public async includeNewChanges(
    options: RefreshReviewOptions = {},
  ): Promise<IncludeNewChangesResult> {
    return runRepositoryMutation(this.#store.fingerprint, async () => {
      const previous = await this.requireMutableActive(options);
      const session = await this.#repository.openReadSession(options.signal);
      const selection = await session.extendSelection(
        previous.review.orderedChangeIds,
        options.signal,
      );
      const record = await this.captureAndCommit(
        previous,
        selection,
        session,
        options,
        true,
      );
      return {
        record,
        addedChangeCount:
          record.review.orderedChangeIds.length -
          previous.review.orderedChangeIds.length,
      };
    });
  }

  private async refreshActiveUnlocked(
    options: RefreshReviewOptions,
  ): Promise<RefreshReviewResult> {
    const previous = await this.requireMutableActive(options);
    const session = await this.#repository.openReadSession(options.signal);
    const selection = await session.resolveSelection(
      previous.review.orderedChangeIds,
      options.signal,
    );
    const record = await this.captureAndCommit(
      previous,
      selection,
      session,
      options,
      false,
    );
    if (record === previous) {
      return { record: previous, changed: false };
    }
    return { record, changed: true };
  }

  private async requireMutableActive(
    options: ReviewMutationOptions,
  ): Promise<ReviewRecord> {
    const previous = await this.#store.getActiveReview();
    if (previous === undefined) {
      throw new NoActiveReviewError();
    }
    if (previous.review.state !== "active") {
      throw new ArchivedReviewReadOnlyError(previous.review.id);
    }
    if (
      options.expectedCurrentSnapshotId !== undefined &&
      previous.review.currentSnapshotId !== options.expectedCurrentSnapshotId
    ) {
      throw new StaleReviewError(
        "The active review changed before the operation started.",
      );
    }
    return previous;
  }

  private async captureAndCommit(
    previous: ReviewRecord,
    selection: ReviewSelection,
    session: ReviewReadSession,
    options: RefreshReviewOptions,
    extendSelection: boolean,
  ): Promise<ReviewRecord> {
    const preflight = await this.#capture.preflight(
      selection,
      session,
      options.signal,
    );
    if (
      shouldWarnForChangedLines(preflight, this.#warningLineCount) &&
      options.confirmLargeDiff !== true
    ) {
      throw new LargeDiffConfirmationRequiredError(
        preflight.combinedChangedLineCount,
        this.#warningLineCount,
      );
    }

    const capturedAt = this.#clock().toISOString();
    const prepared = await this.#capture.prepare(selection, session, preflight, {
      snapshotId: this.#uuid(),
      capturedAt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const current = previous.snapshots.find(
      ({ id }) => id === previous.review.currentSnapshotId,
    );
    if (current === undefined) {
      throw new StaleReviewError("The active review has no current snapshot.");
    }
    if (snapshotCaptureEqual(current, prepared.snapshot)) {
      return previous;
    }

    const [updated] = await this.#store.commitPreparedReviews(
      async (blobs) => {
        await prepared.persistBlobs(blobs);
      },
      async (context) => {
        const latest = await context.getReview(previous.review.id);
        if (
          latest.review.state !== "active" ||
          latest.review.currentSnapshotId !== previous.review.currentSnapshotId
        ) {
          throw new StaleReviewError(
            "The active review changed before the refresh was committed.",
          );
        }
        const projected = projectFileComments(
          latest,
          prepared.snapshot,
          capturedAt,
        );
        const blobReads = new Map<string, Promise<Buffer>>();
        const threads =
          this.#projectComments === undefined
            ? projected
            : await this.#projectComments({
                previous: structuredClone(latest),
                nextSnapshot: prepared.snapshot,
                defaultFileProjections: structuredClone(projected),
                readBlob: (reference) => {
                  const existing = blobReads.get(reference.sha256);
                  if (existing !== undefined) {
                    return existing;
                  }
                  const read = this.#store.blobs.get(reference);
                  blobReads.set(reference.sha256, read);
                  return read;
                },
              });
        validateProjectionBoundary(latest, threads);
        return [
          parseReviewRecord({
            review: {
              ...latest.review,
              updatedAt: capturedAt,
              ...(extendSelection
                ? {
                    orderedChangeIds: [...selection.changeIds],
                  }
                : {}),
              currentSnapshotId: prepared.snapshot.id,
              snapshotIds: [
                ...latest.review.snapshotIds,
                prepared.snapshot.id,
              ],
              counts: countComments(threads),
            },
            snapshots: [...latest.snapshots, prepared.snapshot],
            threads,
          }),
        ];
      },
    );
    if (updated === undefined) {
      throw new StaleReviewError("The refresh did not commit a review record.");
    }
    return updated;
  }
}

function snapshotCaptureEqual(current: Snapshot, candidate: Snapshot): boolean {
  return (
    current.changes.map(({ commitId }) => commitId).join("\0") ===
      candidate.changes.map(({ commitId }) => commitId).join("\0") &&
    current.baseCommitId === candidate.baseCommitId &&
    current.headCommitId === candidate.headCommitId &&
    JSON.stringify(current.views) === JSON.stringify(candidate.views)
  );
}

function projectFileComments(
  previous: ReviewRecord,
  snapshot: Snapshot,
  updatedAt: string,
): readonly CommentThread[] {
  return previous.threads.map((thread) => {
    if (thread.anchor.target.kind !== "file") {
      return {
        ...thread,
        projection: null,
        currentness: "outdated" as const,
        updatedAt,
      };
    }
    const view = snapshot.views.find(
      ({ identity }) =>
        viewIdentityKey(identity) === viewIdentityKey(thread.anchor.view),
    );
    const paths = new Set(
      [
        thread.projection?.path,
        thread.anchor.currentPath,
        thread.anchor.originalPath,
      ].filter((value): value is string => value !== undefined && value !== null),
    );
    const matches =
      view?.files.filter((file) => fileMatchesAnyPath(file, paths)) ?? [];
    const match = matches.length === 1 ? matches[0] : undefined;
    const mappedPath = match?.currentPath ?? match?.originalPath;
    if (mappedPath === undefined || mappedPath === null) {
      return {
        ...thread,
        projection: null,
        currentness: "outdated" as const,
        updatedAt,
      };
    }
    return {
      ...thread,
      projection: {
        snapshotId: snapshot.id,
        view: copyView(thread.anchor.view),
        path: mappedPath,
        target: { kind: "file" as const },
      },
      currentness: "current" as const,
      updatedAt,
    };
  });
}

function fileMatchesAnyPath(
  file: FileManifestEntry,
  paths: ReadonlySet<string>,
): boolean {
  return (
    (file.originalPath !== null && paths.has(file.originalPath)) ||
    (file.currentPath !== null && paths.has(file.currentPath))
  );
}

function copyView(view: ViewIdentity): ViewIdentity {
  return view.mode === "combined"
    ? { mode: "combined" }
    : { mode: "per-change", changeId: view.changeId };
}

function validateProjectionBoundary(
  previous: ReviewRecord,
  projected: readonly CommentThread[],
): void {
  if (
    projected.length !== previous.threads.length ||
    projected.some((thread, index) => {
      const old = previous.threads[index];
      return (
        thread.commentId !== old?.commentId ||
        JSON.stringify(thread.anchor) !== JSON.stringify(old.anchor) ||
        JSON.stringify(thread.messages) !== JSON.stringify(old.messages) ||
        thread.reviewId !== old.reviewId ||
        thread.state !== old.state ||
        thread.resolvedAt !== old.resolvedAt
      );
    })
  ) {
    throw new StaleReviewError(
      "The comment projection hook changed immutable comment data.",
    );
  }
}

function countComments(threads: readonly CommentThread[]): {
  readonly open: number;
  readonly outdated: number;
  readonly resolved: number;
} {
  return {
    open: threads.filter(
      ({ state, currentness }) => state === "open" && currentness === "current",
    ).length,
    outdated: threads.filter(
      ({ state, currentness }) => state === "open" && currentness === "outdated",
    ).length,
    resolved: threads.filter(({ state }) => state === "resolved").length,
  };
}
