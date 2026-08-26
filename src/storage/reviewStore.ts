import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReviewRecord, type ReviewRecord } from "../domain/comments";
import { DomainError, StorageError, errorMessage } from "../domain/errors";
import type { BlobReference } from "../domain/review";
import {
  atomicWriteFile,
  AtomicWriteError,
  cleanupTemporaryFiles,
  type StorageFaultInjector,
} from "./atomicFile";
import { BlobStore } from "./blobStore";
import {
  CURRENT_SCHEMA_VERSION,
  migrateAndParseIndex,
  migrateAndParseReview,
  type PersistedReviewManifest,
  type ReviewIndexEntry,
  type ReviewIndexManifest,
} from "./migrations";
import { RepositoryLock, type RepositoryLockOptions } from "./repositoryLock";

export type StorageLocation = string | URL | { readonly fsPath: string };

export interface RepositoryFingerprintInput {
  readonly canonicalRepositoryRoot: string;
  readonly environment: string;
  readonly platform?: NodeJS.Platform;
}

export interface ReviewStoreOptions extends RepositoryFingerprintInput {
  readonly storageRoot: StorageLocation;
  readonly archiveRetention?: number;
  readonly faultInjector?: StorageFaultInjector;
  readonly lockOptions?: RepositoryLockOptions;
}

export interface StoreRecoveryDiagnostic {
  readonly reviewId: string;
  readonly manifestFile: string;
  readonly wasActive: boolean;
  readonly reason: "missing-manifest" | "corrupt-manifest";
  readonly message: string;
  readonly quarantinedPath?: string;
}

export interface PreparedReviewCommitContext {
  getActiveReview(): Promise<ReviewRecord | undefined>;
  getReview(reviewId: string): Promise<ReviewRecord>;
}

function storagePath(location: StorageLocation): string {
  if (typeof location === "string") {
    return path.resolve(location);
  }
  if (location instanceof URL) {
    if (location.protocol !== "file:") {
      throw new StorageError("IO_ERROR", "Review storage must use a file URI.");
    }
    return fileURLToPath(location);
  }
  return path.resolve(location.fsPath);
}

export function repositoryFingerprint(input: RepositoryFingerprintInput): string {
  const platform = input.platform ?? process.platform;
  let root =
    platform === "win32"
      ? path.win32.normalize(input.canonicalRepositoryRoot).toLocaleLowerCase("en-US")
      : path.posix.normalize(input.canonicalRepositoryRoot.replaceAll("\\", "/"));
  const parser = platform === "win32" ? path.win32 : path.posix;
  if (root !== parser.parse(root).root) {
    root = root.replace(/[\\/]+$/u, "");
  }
  const identity = JSON.stringify({
    version: 1,
    platform,
    root,
    environment: input.environment,
  });
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export class ReviewStore {
  public readonly fingerprint: string;
  public readonly directory: string;
  public readonly blobs: BlobStore;

  readonly #manifestsDirectory: string;
  readonly #indexPath: string;
  readonly #archiveRetention: number;
  readonly #faultInjector: StorageFaultInjector | undefined;
  readonly #lock: RepositoryLock;
  readonly #recoveryDiagnostics: StoreRecoveryDiagnostic[] = [];
  #index: ReviewIndexManifest;
  #writeTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    options: ReviewStoreOptions,
    directory: string,
    fingerprint: string,
    lock: RepositoryLock,
    index: ReviewIndexManifest,
  ) {
    this.fingerprint = fingerprint;
    this.directory = directory;
    this.#manifestsDirectory = path.join(directory, "reviews");
    this.#indexPath = path.join(directory, "index.json");
    this.#archiveRetention = options.archiveRetention ?? 20;
    this.#faultInjector = options.faultInjector;
    this.#lock = lock;
    this.#index = index;
    this.blobs = new BlobStore(path.join(directory, "blobs"), options.faultInjector);
  }

  public static async open(options: ReviewStoreOptions): Promise<ReviewStore> {
    if (
      options.archiveRetention !== undefined &&
      (!Number.isInteger(options.archiveRetention) || options.archiveRetention < 0)
    ) {
      throw new StorageError(
        "CONFLICT",
        "Archive retention must be a non-negative integer.",
      );
    }
    const fingerprint = repositoryFingerprint(options);
    const directory = path.join(storagePath(options.storageRoot), fingerprint);
    const manifestsDirectory = path.join(directory, "reviews");
    await mkdir(manifestsDirectory, { recursive: true });
    const lock = await RepositoryLock.acquire(directory, options.lockOptions);

    try {
      await cleanupTemporaryFiles(directory);
      await cleanupTemporaryFiles(manifestsDirectory);
      const indexPath = path.join(directory, "index.json");
      let index: ReviewIndexManifest;
      try {
        const raw = await readFile(indexPath, "utf8");
        index = migrateAndParseIndex(parseJson(raw, indexPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        index = {
          format: "inreview-index",
          schemaVersion: CURRENT_SCHEMA_VERSION,
          activeReviewId: null,
          reviews: [],
        };
        await atomicWriteFile(
          indexPath,
          stableJson(index),
          "before-index-rename",
          options.faultInjector,
        );
      }

      const store = new ReviewStore(options, directory, fingerprint, lock, index);
      await store.blobs.initialize();
      await store.recoverCorruptEntries();
      await store.garbageCollectUnlocked();
      return store;
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  public get recoveryDiagnostics(): readonly StoreRecoveryDiagnostic[] {
    return this.#recoveryDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public async getActiveReview(): Promise<ReviewRecord | undefined> {
    this.ensureOpen();
    return this.getActiveReviewUnlocked();
  }

  private async getActiveReviewUnlocked(): Promise<ReviewRecord | undefined> {
    const id = this.#index.activeReviewId;
    return id === null ? undefined : this.getReviewUnlocked(id);
  }

  public async listReviews(): Promise<readonly ReviewRecord[]> {
    this.ensureOpen();
    return Promise.all(
      this.#index.reviews.map(async ({ reviewId }) =>
        this.getReviewUnlocked(reviewId),
      ),
    );
  }

  public async getReview(reviewId: string): Promise<ReviewRecord> {
    this.ensureOpen();
    return this.getReviewUnlocked(reviewId);
  }

  private async getReviewUnlocked(reviewId: string): Promise<ReviewRecord> {
    const entry = this.#index.reviews.find((candidate) => candidate.reviewId === reviewId);
    if (entry === undefined) {
      throw new StorageError("NOT_FOUND", `Review ${reviewId} does not exist.`);
    }
    return this.readRecord(entry);
  }

  public async putReview(input: ReviewRecord): Promise<void> {
    return this.runExclusive(async () => this.putReviewsUnlocked([input]));
  }

  public async putReviews(inputs: readonly ReviewRecord[]): Promise<void> {
    return this.runExclusive(async () => this.putReviewsUnlocked(inputs));
  }

  public async commitPreparedReviews(
    persistBlobs: (blobs: BlobStore) => Promise<unknown>,
    buildRecords:
      | readonly ReviewRecord[]
      | ((
          context: PreparedReviewCommitContext,
        ) => readonly ReviewRecord[] | Promise<readonly ReviewRecord[]>),
  ): Promise<readonly ReviewRecord[]> {
    return this.runExclusive(async () => {
      try {
        await persistBlobs(this.blobs);
        const inputs =
          typeof buildRecords === "function"
            ? await buildRecords({
                getActiveReview: async () => {
                  return this.getActiveReviewUnlocked();
                },
                getReview: async (reviewId) => this.getReviewUnlocked(reviewId),
              })
            : buildRecords;
        const records = inputs.map((input) => parseReviewRecord(input));
        await this.verifyRequiredBlobs(records);
        await this.putReviewsUnlocked(records);
        return records;
      } catch (error) {
        await this.garbageCollectUnlocked().catch(() => undefined);
        throw error;
      }
    });
  }

  public async updateReview(
    reviewId: string,
    updater: (record: ReviewRecord) => ReviewRecord | Promise<ReviewRecord>,
  ): Promise<ReviewRecord> {
    return this.runExclusive(async () => {
      const current = await this.getReviewUnlocked(reviewId);
      const updated = await updater(structuredClone(current));
      await this.putReviewsUnlocked([updated]);
      return parseReviewRecord(updated);
    });
  }

  public async deleteReview(reviewId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const entry = this.#index.reviews.find(({ reviewId: id }) => id === reviewId);
      if (entry === undefined) {
        return false;
      }
      const nextIndex: ReviewIndexManifest = {
        ...this.#index,
        activeReviewId:
          this.#index.activeReviewId === reviewId ? null : this.#index.activeReviewId,
        reviews: this.#index.reviews.filter(({ reviewId: id }) => id !== reviewId),
      };
      await this.commitIndex(nextIndex);
      await rm(path.join(this.#manifestsDirectory, entry.manifestFile), { force: true });
      await this.garbageCollectUnlocked();
      return true;
    });
  }

  public async garbageCollect(): Promise<number> {
    return this.runExclusive(async () => this.garbageCollectUnlocked());
  }

  private async garbageCollectUnlocked(): Promise<number> {
    const records = await Promise.all(
      this.#index.reviews.map(async (entry) => this.readRecord(entry)),
    );
    const referenced = new Set<string>();
    for (const { snapshots } of records) {
      for (const snapshot of snapshots) {
        for (const view of snapshot.views) {
          for (const file of view.files) {
            addReference(referenced, file.originalContent);
            addReference(referenced, file.modifiedContent);
            addReference(referenced, file.patch);
          }
        }
      }
    }
    return this.blobs.garbageCollect(referenced);
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closing = true;
    const closePromise = (async () => {
      try {
        await this.#writeTail;
        await this.#lock.release();
      } finally {
        this.#closed = true;
        this.#closing = false;
      }
    })();
    this.#closePromise = closePromise;
    return closePromise;
  }

  private async putReviewsUnlocked(inputs: readonly ReviewRecord[]): Promise<void> {
    if (inputs.length === 0) {
      return;
    }
    const records = inputs.map((input) => parseReviewRecord(input));
    if (new Set(records.map(({ review }) => review.id)).size !== records.length) {
      throw new StorageError("CONFLICT", "A review batch cannot contain duplicate review IDs.");
    }
    for (const record of records) {
      if (record.review.repositoryFingerprint !== this.fingerprint) {
        throw new StorageError("CONFLICT", "The review belongs to a different repository.");
      }
      const previous = this.#index.reviews.find(
        ({ reviewId }) => reviewId === record.review.id,
      );
      if (previous !== undefined) {
        const previousRecord = await this.readRecord(previous);
        for (const snapshot of previousRecord.snapshots) {
          const replacement = record.snapshots.find(({ id }) => id === snapshot.id);
          if (
            replacement === undefined ||
            stableJson(replacement) !== stableJson(snapshot)
          ) {
            throw new StorageError(
              "CONFLICT",
              `Snapshot ${snapshot.id} is immutable and cannot be changed or removed.`,
            );
          }
        }
      }
    }

    const replacementIds = new Set(records.map(({ review }) => review.id));
    const previousEntries = this.#index.reviews.filter(({ reviewId }) =>
      replacementIds.has(reviewId),
    );
    const manifestWrites = records.map((record) => {
      const manifestFile = `${randomUUID()}.json`;
      return {
        record,
        manifestFile,
        manifestPath: path.join(this.#manifestsDirectory, manifestFile),
        entry: {
          reviewId: record.review.id,
          manifestFile,
          state: record.review.state,
          updatedAt: record.review.updatedAt,
          archivedAt: record.review.archivedAt,
        } satisfies ReviewIndexEntry,
      };
    });
    let nextReviews = [
      ...this.#index.reviews.filter(({ reviewId }) => !replacementIds.has(reviewId)),
      ...manifestWrites.map(({ entry }) => entry),
    ];
    const active = nextReviews.filter(({ state }) => state === "active");
    if (active.length > 1) {
      throw new StorageError(
        "CONFLICT",
        `Review ${active[0]?.reviewId ?? "unknown"} is already active.`,
      );
    }
    const archived = nextReviews
      .filter(({ state }) => state === "archived")
      .sort(
        (left, right) =>
          Date.parse(right.archivedAt ?? right.updatedAt) -
          Date.parse(left.archivedAt ?? left.updatedAt),
      );
    const pruned = archived.slice(this.#archiveRetention);
    const prunedIds = new Set(pruned.map(({ reviewId }) => reviewId));
    nextReviews = nextReviews.filter(({ reviewId }) => !prunedIds.has(reviewId));
    const nextIndex: ReviewIndexManifest = {
      format: "inreview-index",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      activeReviewId: active[0]?.reviewId ?? null,
      reviews: nextReviews,
    };
    try {
      for (const { record, manifestPath } of manifestWrites) {
        await atomicWriteFile(
          manifestPath,
          stableJson({
            format: "inreview-review",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            record,
          } satisfies PersistedReviewManifest),
          "before-manifest-rename",
          this.#faultInjector,
        );
      }
      await this.commitIndex(nextIndex);
    } catch (error) {
      if (stableJson(this.#index) !== stableJson(nextIndex)) {
        await Promise.all(
          manifestWrites.map(async ({ manifestPath }) => {
            await rm(manifestPath, { force: true }).catch(() => undefined);
          }),
        );
        await this.garbageCollectUnlocked().catch(() => undefined);
      }
      throw error;
    }
    const obsoleteFiles = [
      ...previousEntries.map(({ manifestFile }) => manifestFile),
      ...pruned.map(({ manifestFile: file }) => file),
    ].filter((file) => !manifestWrites.some(({ manifestFile }) => manifestFile === file));
    await Promise.all(
      obsoleteFiles.map(async (file) => {
        await rm(path.join(this.#manifestsDirectory, file), { force: true }).catch(
          () => undefined,
        );
      }),
    );
    await this.garbageCollectUnlocked().catch(() => undefined);
  }

  private async commitIndex(index: ReviewIndexManifest): Promise<void> {
    const parsed = migrateAndParseIndex(index);
    try {
      await atomicWriteFile(
        this.#indexPath,
        stableJson(parsed),
        "before-index-rename",
        this.#faultInjector,
      );
      this.#index = parsed;
    } catch (error) {
      if (
        error instanceof AtomicWriteError &&
        error.destinationReplaced
      ) {
        this.#index = parsed;
      }
      throw error;
    }
  }

  private async readRecord(entry: ReviewIndexEntry): Promise<ReviewRecord> {
    const filePath = path.join(this.#manifestsDirectory, entry.manifestFile);
    try {
      const raw = await readFile(filePath, "utf8");
      const persisted = migrateAndParseReview(parseJson(raw, filePath));
      const record = parseReviewRecord(persisted.record);
      if (
        record.review.id !== entry.reviewId ||
        record.review.state !== entry.state ||
        record.review.updatedAt !== entry.updatedAt
      ) {
        throw new StorageError(
          "CORRUPT_DATA",
          `The review manifest does not match its index entry.`,
          { path: filePath },
        );
      }
      return record;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (error instanceof DomainError) {
        throw new StorageError("CORRUPT_DATA", "The review manifest contains invalid domain data.", {
          cause: error,
          path: filePath,
        });
      }
      throw new StorageError(
        "IO_ERROR",
        `Could not read review ${entry.reviewId}: ${errorMessage(error)}`,
        { cause: error, path: filePath },
      );
    }
  }

  private async verifyRequiredBlobs(records: readonly ReviewRecord[]): Promise<void> {
    const references = new Map<string, BlobReference>();
    for (const { snapshots } of records) {
      for (const snapshot of snapshots) {
        for (const view of snapshot.views) {
          for (const file of view.files) {
            addReferenceValue(references, file.originalContent);
            addReferenceValue(references, file.modifiedContent);
            addReferenceValue(references, file.patch);
          }
        }
      }
    }
    await Promise.all(
      [...references.values()].map(async (reference) => this.blobs.get(reference)),
    );
  }

  private async recoverCorruptEntries(): Promise<void> {
    const valid: ReviewIndexEntry[] = [];
    for (const entry of this.#index.reviews) {
      try {
        await this.readRecord(entry);
        valid.push(entry);
      } catch (error) {
        const storageError =
          error instanceof StorageError
            ? error
            : new StorageError("CORRUPT_DATA", errorMessage(error), {
                cause: error,
              });
        const manifestPath = path.join(
          this.#manifestsDirectory,
          entry.manifestFile,
        );
        const missing =
          storageError.cause instanceof Error &&
          (storageError.cause as NodeJS.ErrnoException).code === "ENOENT";
        if (storageError.code !== "CORRUPT_DATA" && !missing) {
          throw error;
        }
        let quarantinedPath: string | undefined;
        if (!missing) {
          const quarantineDirectory = path.join(
            this.#manifestsDirectory,
            "quarantine",
          );
          await mkdir(quarantineDirectory, { recursive: true });
          quarantinedPath = path.join(
            quarantineDirectory,
            `${entry.manifestFile}.corrupt-${randomUUID()}`,
          );
          try {
            await rename(manifestPath, quarantinedPath);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw renameError;
            }
            quarantinedPath = undefined;
          }
        }
        this.#recoveryDiagnostics.push({
          reviewId: entry.reviewId,
          manifestFile: entry.manifestFile,
          wasActive: this.#index.activeReviewId === entry.reviewId,
          reason: missing ? "missing-manifest" : "corrupt-manifest",
          message: storageError.message,
          ...(quarantinedPath === undefined ? {} : { quarantinedPath }),
        });
      }
    }
    if (valid.length === this.#index.reviews.length) {
      return;
    }
    const validIds = new Set(valid.map(({ reviewId }) => reviewId));
    await this.commitIndex({
      ...this.#index,
      activeReviewId:
        this.#index.activeReviewId !== null &&
        validIds.has(this.#index.activeReviewId)
          ? this.#index.activeReviewId
          : null,
      reviews: valid,
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    const previous = this.#writeTail;
    let release: () => void = () => undefined;
    this.#writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private ensureOpen(): void {
    if (this.#closed || this.#closing) {
      throw new StorageError("CONFLICT", "The review store is closed.");
    }
  }
}

function addReference(set: Set<string>, reference: BlobReference | null): void {
  if (reference !== null) {
    set.add(reference.sha256);
  }
}

function addReferenceValue(
  references: Map<string, BlobReference>,
  reference: BlobReference | null,
): void {
  if (reference !== null) {
    references.set(reference.sha256, reference);
  }
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StorageError("CORRUPT_DATA", `The JSON in "${filePath}" is invalid.`, {
      cause: error,
      path: filePath,
    });
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
