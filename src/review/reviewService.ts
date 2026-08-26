import { randomUUID } from "node:crypto";
import path from "node:path";

import { parseReviewRecord, type ReviewRecord } from "../domain/comments";
import { StorageError } from "../domain/errors";
import { JjClient, type JjClientOptions } from "../jj/jjClient";
import { shouldWarnForChangedLines } from "../jj/snapshotBuilder";
import { repositoryFingerprint, ReviewStore } from "../storage/reviewStore";
import type { ReviewStoreOptions, StorageLocation } from "../storage/reviewStore";
import {
  ActiveReviewConflictError,
  ArchivedReviewReadOnlyError,
  InvalidChangeCountError,
  LargeDiffConfirmationRequiredError,
  NoActiveReviewError,
  ReviewNotFoundError,
  StaleReviewError,
} from "./errors";
import { runRepositoryMutation } from "./mutationQueue";
import {
  productionReviewCapture,
  RefreshService,
  type RefreshReviewOptions,
  type RefreshReviewResult,
} from "./refreshService";
import { CommentService } from "./commentService";
import type {
  CommentProjectionHook,
  ReviewCapture,
  ReviewChangeEvent,
  ReviewMutationOptions,
  ReviewRepository,
  ReviewSubscription,
} from "./types";

export interface StartReviewOptions {
  readonly requestedChangeCount: number;
  readonly confirmLargeDiff?: boolean;
  readonly signal?: AbortSignal;
}

export interface StartReviewResult {
  readonly record: ReviewRecord;
  readonly actualChangeCount: number;
  readonly truncatedAtRoot: boolean;
}

export interface ReviewServiceOptions {
  readonly canonicalRepositoryRoot: string;
  readonly environment: string;
  readonly store: ReviewStore;
  readonly repository: ReviewRepository;
  readonly warningLineCount?: number;
  readonly capture?: ReviewCapture;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  readonly projectComments?: CommentProjectionHook;
}

export interface CreateReviewServiceOptions {
  readonly repositoryPath: string;
  readonly environment: string;
  readonly storageRoot: StorageLocation;
  readonly archiveRetention?: number;
  readonly jj?: JjClientOptions;
  readonly warningLineCount?: number;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  readonly projectComments?: CommentProjectionHook;
  readonly signal?: AbortSignal;
  readonly storeOptions?: Pick<ReviewStoreOptions, "faultInjector" | "lockOptions">;
}

export class ReviewService {
  public readonly canonicalRepositoryRoot: string;
  public readonly environment: string;
  public readonly storageKey: string;
  public readonly refreshService: RefreshService;
  public readonly commentService: CommentService;

  readonly #store: ReviewStore;
  readonly #repository: ReviewRepository;
  readonly #warningLineCount: number;
  readonly #capture: ReviewCapture;
  readonly #clock: () => Date;
  readonly #uuid: () => string;
  readonly #listeners = new Set<(event: ReviewChangeEvent) => void>();
  #ownsStore = false;

  public constructor(options: ReviewServiceOptions) {
    this.canonicalRepositoryRoot = path.resolve(options.canonicalRepositoryRoot);
    this.environment = options.environment;
    this.#store = options.store;
    this.#repository = options.repository;
    this.storageKey = options.store.fingerprint;
    this.#warningLineCount = options.warningLineCount ?? 10_000;
    if (
      !Number.isSafeInteger(this.#warningLineCount) ||
      this.#warningLineCount < 0
    ) {
      throw new RangeError("The changed-line warning setting must be non-negative.");
    }
    if (
      !sameRepositoryPath(this.canonicalRepositoryRoot, options.repository.repository)
    ) {
      throw new TypeError(
        "The review service and jj client must use the same canonical repository root.",
      );
    }
    if (
      repositoryFingerprint({
        canonicalRepositoryRoot: this.canonicalRepositoryRoot,
        environment: this.environment,
      }) !== this.storageKey
    ) {
      throw new TypeError(
        "The review store key does not match the canonical repository and environment.",
      );
    }
    this.#capture = options.capture ?? productionReviewCapture;
    this.#clock = options.clock ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.commentService = new CommentService({
      store: this.#store,
      clock: this.#clock,
      uuid: this.#uuid,
    });
    this.refreshService = new RefreshService({
      store: this.#store,
      repository: this.#repository,
      warningLineCount: this.#warningLineCount,
      capture: this.#capture,
      clock: this.#clock,
      uuid: this.#uuid,
      ...(options.projectComments === undefined
        ? {}
        : { projectComments: options.projectComments }),
    });
  }

  public static async create(
    options: CreateReviewServiceOptions,
  ): Promise<ReviewService> {
    const probe = new JjClient(options.repositoryPath, options.jj);
    const canonicalRepositoryRoot = await probe.resolveRepositoryRoot(options.signal);
    const repository = new JjClient(canonicalRepositoryRoot, options.jj);
    const store = await ReviewStore.open({
      storageRoot: options.storageRoot,
      canonicalRepositoryRoot,
      environment: options.environment,
      ...(options.archiveRetention === undefined
        ? {}
        : { archiveRetention: options.archiveRetention }),
      ...(options.storeOptions?.faultInjector === undefined
        ? {}
        : { faultInjector: options.storeOptions.faultInjector }),
      ...(options.storeOptions?.lockOptions === undefined
        ? {}
        : { lockOptions: options.storeOptions.lockOptions }),
    });
    try {
      const service = new ReviewService({
        canonicalRepositoryRoot,
        environment: options.environment,
        store,
        repository,
        ...(options.warningLineCount === undefined
          ? {}
          : { warningLineCount: options.warningLineCount }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
        ...(options.projectComments === undefined
          ? {}
          : { projectComments: options.projectComments }),
      });
      service.#ownsStore = true;
      return service;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  public subscribe(
    listener: (event: ReviewChangeEvent) => void,
  ): ReviewSubscription {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public async startReview(
    options: StartReviewOptions,
  ): Promise<StartReviewResult> {
    validateChangeCount(options.requestedChangeCount);
    return runRepositoryMutation(this.storageKey, async () => {
      const active = await this.#store.getActiveReview();
      if (active !== undefined) {
        throw new ActiveReviewConflictError(active.review.id);
      }
      return this.prepareAndCommitStart(options);
    });
  }

  public async archiveAndStartReview(
    options: StartReviewOptions,
  ): Promise<StartReviewResult> {
    validateChangeCount(options.requestedChangeCount);
    return runRepositoryMutation(this.storageKey, async () => {
      const active = await this.#store.getActiveReview();
      return this.prepareAndCommitStart(options, active);
    });
  }

  public async refreshReview(
    options: RefreshReviewOptions = {},
  ): Promise<RefreshReviewResult> {
    const result = await this.refreshService.refreshActive(options);
    if (result.changed) {
      this.emit({
        type: "refreshed",
        repositoryFingerprint: this.storageKey,
        reviewId: result.record.review.id,
        snapshotId: result.record.review.currentSnapshotId,
      });
    }
    return result;
  }

  public async archiveActiveReview(
    options: ReviewMutationOptions = {},
  ): Promise<ReviewRecord> {
    return runRepositoryMutation(this.storageKey, async () => {
      const active = await this.requireActive();
      assertExpectedSnapshot(active, options.expectedCurrentSnapshotId);
      const archived = archiveRecord(active, this.#clock().toISOString());
      await this.#store.putReview(archived);
      this.emit({
        type: "archived",
        repositoryFingerprint: this.storageKey,
        reviewId: archived.review.id,
      });
      return archived;
    });
  }

  public async restoreReview(reviewId: string): Promise<ReviewRecord> {
    return runRepositoryMutation(this.storageKey, async () => {
      const active = await this.#store.getActiveReview();
      if (active !== undefined) {
        throw new ActiveReviewConflictError(active.review.id);
      }
      return this.restoreUnlocked(reviewId);
    });
  }

  public async archiveActiveAndRestoreReview(
    reviewId: string,
    options: ReviewMutationOptions = {},
  ): Promise<ReviewRecord> {
    return runRepositoryMutation(this.storageKey, async () => {
      const target = await this.getReview(reviewId);
      if (target.review.state !== "archived") {
        throw new ActiveReviewConflictError(target.review.id);
      }
      const active = await this.#store.getActiveReview();
      const timestamp = this.#clock().toISOString();
      const restored = restoreRecord(target, timestamp);
      if (active === undefined) {
        await this.#store.putReview(restored);
      } else {
        assertExpectedSnapshot(active, options.expectedCurrentSnapshotId);
        await this.#store.putReviews([
          archiveRecord(active, timestamp),
          restored,
        ]);
      }
      this.emit({
        type: "restored",
        repositoryFingerprint: this.storageKey,
        reviewId: restored.review.id,
        snapshotId: restored.review.currentSnapshotId,
      });
      return restored;
    });
  }

  public async renameActiveReview(
    name: string,
    options: ReviewMutationOptions = {},
  ): Promise<ReviewRecord> {
    const normalized = name.trim();
    if (normalized.length === 0 || normalized.length > 512) {
      throw new RangeError("A review name must contain 1 to 512 characters.");
    }
    return runRepositoryMutation(this.storageKey, async () => {
      const active = await this.requireActive();
      assertExpectedSnapshot(active, options.expectedCurrentSnapshotId);
      const renamed = parseReviewRecord({
        ...active,
        review: {
          ...active.review,
          name: normalized,
          updatedAt: this.#clock().toISOString(),
        },
      });
      await this.#store.putReview(renamed);
      this.emit({
        type: "renamed",
        repositoryFingerprint: this.storageKey,
        reviewId: renamed.review.id,
      });
      return renamed;
    });
  }

  public async deleteArchivedReview(reviewId: string): Promise<void> {
    await runRepositoryMutation(this.storageKey, async () => {
      const record = await this.getReview(reviewId);
      if (record.review.state !== "archived") {
        throw new ActiveReviewConflictError(record.review.id);
      }
      if (!(await this.#store.deleteReview(reviewId))) {
        throw new ReviewNotFoundError(reviewId);
      }
      this.emit({
        type: "deleted",
        repositoryFingerprint: this.storageKey,
        reviewId,
      });
    });
  }

  public async getActiveReview(): Promise<ReviewRecord> {
    return this.requireActive();
  }

  public async getActiveReviewOrUndefined(): Promise<ReviewRecord | undefined> {
    return this.#store.getActiveReview();
  }

  public async getReview(reviewId: string): Promise<ReviewRecord> {
    try {
      return await this.#store.getReview(reviewId);
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        throw new ReviewNotFoundError(reviewId, { cause: error });
      }
      throw error;
    }
  }

  public async listHistory(): Promise<readonly ReviewRecord[]> {
    return (await this.#store.listReviews())
      .filter(({ review }) => review.state === "archived")
      .sort(
        (left, right) =>
          Date.parse(right.review.archivedAt ?? right.review.updatedAt) -
          Date.parse(left.review.archivedAt ?? left.review.updatedAt),
      );
  }

  public async close(): Promise<void> {
    if (this.#ownsStore) {
      await this.#store.close();
      this.#ownsStore = false;
    }
  }

  private async prepareAndCommitStart(
    options: StartReviewOptions,
    activeToArchive?: ReviewRecord,
  ): Promise<StartReviewResult> {
    const session = await this.#repository.openReadSession(options.signal);
    const selection = await session.selectLast(
      options.requestedChangeCount,
      options.signal,
    );
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
    const createdAt = this.#clock().toISOString();
    const prepared = await this.#capture.prepare(selection, session, preflight, {
      snapshotId: this.#uuid(),
      capturedAt: createdAt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const reviewId = this.#uuid();
    const record = parseReviewRecord({
      review: {
        id: reviewId,
        name: defaultReviewName(
          selection.commits.at(-1)?.subject ?? "",
          createdAt,
        ),
        state: "active",
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        repositoryFingerprint: this.storageKey,
        requestedChangeCount: options.requestedChangeCount,
        orderedChangeIds: [...selection.changeIds],
        currentSnapshotId: prepared.snapshot.id,
        snapshotIds: [prepared.snapshot.id],
        counts: { open: 0, outdated: 0, resolved: 0 },
      },
      snapshots: [prepared.snapshot],
      threads: [],
    });
    await this.#store.commitPreparedReviews(
      async (blobs) => {
        await prepared.persistBlobs(blobs);
      },
      async (context) => {
        if (activeToArchive === undefined) {
          const active = await context.getActiveReview();
          if (active !== undefined) {
            throw new ActiveReviewConflictError(active.review.id);
          }
          return [record];
        }
        const currentActive = await context.getReview(activeToArchive.review.id);
        if (currentActive.review.state !== "active") {
          throw new StaleReviewError(
            "The active review changed before the new review was committed.",
          );
        }
        return [archiveRecord(currentActive, createdAt), record];
      },
    );
    this.emit({
      type: "started",
      repositoryFingerprint: this.storageKey,
      reviewId,
      snapshotId: prepared.snapshot.id,
    });
    return {
      record,
      actualChangeCount: selection.actualCount,
      truncatedAtRoot: selection.truncatedAtRoot,
    };
  }

  private async restoreUnlocked(reviewId: string): Promise<ReviewRecord> {
    const record = await this.getReview(reviewId);
    if (record.review.state !== "archived") {
      throw new ActiveReviewConflictError(record.review.id);
    }
    const restored = restoreRecord(record, this.#clock().toISOString());
    await this.#store.putReview(restored);
    this.emit({
      type: "restored",
      repositoryFingerprint: this.storageKey,
      reviewId,
      snapshotId: restored.review.currentSnapshotId,
    });
    return restored;
  }

  private async requireActive(): Promise<ReviewRecord> {
    const active = await this.#store.getActiveReview();
    if (active === undefined) {
      throw new NoActiveReviewError();
    }
    if (active.review.state !== "active") {
      throw new ArchivedReviewReadOnlyError(active.review.id);
    }
    return active;
  }

  private emit(event: ReviewChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber cannot roll back a mutation that already persisted.
      }
    }
  }
}

function validateChangeCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new InvalidChangeCountError(count);
  }
}

function defaultReviewName(subject: string, createdAt: string): string {
  const firstLine = subject.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const title = firstLine.length === 0 ? "Untitled change" : firstLine;
  return `${title} — ${createdAt.slice(0, 16).replace("T", " ")} UTC`;
}

function archiveRecord(record: ReviewRecord, timestamp: string): ReviewRecord {
  return parseReviewRecord({
    ...record,
    review: {
      ...record.review,
      state: "archived",
      updatedAt: timestamp,
      archivedAt: timestamp,
    },
  });
}

function restoreRecord(record: ReviewRecord, timestamp: string): ReviewRecord {
  return parseReviewRecord({
    ...record,
    review: {
      ...record.review,
      state: "active",
      updatedAt: timestamp,
      archivedAt: null,
    },
  });
}

function assertExpectedSnapshot(
  record: ReviewRecord,
  expectedSnapshotId: string | undefined,
): void {
  if (
    expectedSnapshotId !== undefined &&
    record.review.currentSnapshotId !== expectedSnapshotId
  ) {
    throw new StaleReviewError("The active review changed before the operation.");
  }
}

function sameRepositoryPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/u, "");
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
