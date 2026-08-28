import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ReviewRecord } from "../../src/domain/comments";
import { JjStaleSelectionError } from "../../src/jj/errors";
import { parseGitPatch } from "../../src/diff";
import type {
  JjChangedFile,
  JjCommit,
  JjFile,
  JjFileProbe,
  JjOperation,
  ReviewHistoryPage,
  ReviewSelection,
} from "../../src/jj/types";
import {
  ActiveReviewConflictError,
  LargeDiffConfirmationRequiredError,
  NoActiveReviewError,
  ReviewService,
  type ReviewReadSession,
  type ReviewRepository,
} from "../../src/review";
import { ReviewStore } from "../../src/storage";

const workRoot = path.resolve(".test-work", "review-lifecycle");
const usedDirectories = new Set<string>();
const canonicalRepositoryRoot = path.resolve(".test-work", "review-repository");

afterEach(async () => {
  await Promise.all(
    [...usedDirectories].map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  usedDirectories.clear();
});

interface Version {
  readonly selection: ReviewSelection;
  readonly patch: string;
  readonly files: ReadonlyMap<string, readonly JjFile[]>;
  readonly contents: ReadonlyMap<string, Buffer>;
  readonly operation: JjOperation;
  readonly resolveError?: Error;
}

class FakeSession implements ReviewReadSession {
  public readonly operationId: string;

  public constructor(private readonly version: Version) {
    this.operationId = version.operation.id;
  }

  public get operation(): JjOperation {
    return this.version.operation;
  }

  public selectLast(count: number): Promise<ReviewSelection> {
    return Promise.resolve({
      ...this.version.selection,
      requestedCount: count,
      truncatedAtRoot: this.version.selection.actualCount < count,
    });
  }

  public listHistory(count: number): Promise<ReviewHistoryPage> {
    return Promise.resolve({
      commits: this.version.selection.commits.slice(-count),
      requestedCount: count,
      hasMore: this.version.selection.commits.length > count,
      reachedRoot: this.version.selection.truncatedAtRoot,
    });
  }

  public selectRange(): Promise<ReviewSelection> {
    return Promise.resolve(this.version.selection);
  }

  public selectRevset(): Promise<ReviewSelection> {
    return Promise.resolve(this.version.selection);
  }

  public resolveSelection(
    storedChangeIds: readonly string[],
  ): Promise<ReviewSelection> {
    if (this.version.resolveError !== undefined) {
      return Promise.reject(this.version.resolveError);
    }
    expect(storedChangeIds).toEqual(this.version.selection.changeIds);
    return Promise.resolve(this.version.selection);
  }

  public extendSelection(
    storedChangeIds: readonly string[],
  ): Promise<ReviewSelection> {
    if (
      storedChangeIds.some(
        (changeId, index) => this.version.selection.changeIds[index] !== changeId,
      )
    ) {
      return Promise.reject(
        new JjStaleSelectionError(
          "The selected changes are not an ancestor prefix.",
        ),
      );
    }
    return Promise.resolve(this.version.selection);
  }

  public diffGit(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.version.patch));
  }

  public listChangedFiles(
    fromCommitId: string,
    toCommitId: string,
  ): Promise<readonly JjChangedFile[]> {
    const oldFiles = new Map(
      (this.version.files.get(fromCommitId) ?? []).map((file) => [file.path, file]),
    );
    const newFiles = new Map(
      (this.version.files.get(toCommitId) ?? []).map((file) => [file.path, file]),
    );
    return Promise.resolve(
      parseGitPatch(this.version.patch).map((patch) => ({
        status: patch.status,
        originalPath: patch.originalPath,
        currentPath: patch.currentPath,
        oldFileType:
          patch.originalPath === null
            ? null
            : (oldFiles.get(patch.originalPath)?.fileType ?? null),
        newFileType:
          patch.currentPath === null
            ? null
            : (newFiles.get(patch.currentPath)?.fileType ?? null),
      })),
    );
  }

  public listFiles(
    commitId: string,
    repositoryRelativePaths: readonly string[],
  ): Promise<readonly JjFile[]> {
    const paths = new Set(repositoryRelativePaths);
    return Promise.resolve(
      (this.version.files.get(commitId) ?? []).filter(({ path: filePath }) =>
        paths.has(filePath),
      ),
    );
  }

  public readFile(
    commitId: string,
    repositoryRelativePath: string,
  ): Promise<Buffer> {
    const content = this.version.contents.get(
      `${commitId}\0${repositoryRelativePath}`,
    );
    if (content === undefined) {
      return Promise.reject(
        new Error(`Missing fake content for ${commitId}:${repositoryRelativePath}`),
      );
    }
    return Promise.resolve(Buffer.from(content));
  }

  public async probeFile(
    commitId: string,
    repositoryRelativePath: string,
  ): Promise<JjFileProbe> {
    const content = await this.readFile(commitId, repositoryRelativePath);
    return {
      prefix: content.subarray(0, 8192),
      byteLength: content.byteLength,
      containsNul: content.includes(0),
    };
  }
}

class FakeRepository implements ReviewRepository {
  public readonly repository = canonicalRepositoryRoot;
  public maxConcurrentOpens = 0;
  public openCount = 0;
  public currentOperationId: string | undefined;
  #activeOpens = 0;
  #next = 0;

  public constructor(
    private readonly versions: readonly Version[],
    private readonly openDelayMs = 0,
  ) {}

  public getCurrentOperationId(): Promise<string> {
    if (this.currentOperationId !== undefined) {
      return Promise.resolve(this.currentOperationId);
    }
    const version =
      this.versions[Math.max(0, Math.min(this.#next - 1, this.versions.length - 1))];
    if (version === undefined) {
      return Promise.reject(new Error("The fake repository has no version."));
    }
    return Promise.resolve(version.operation.id);
  }

  public async openReadSession(): Promise<ReviewReadSession> {
    this.#activeOpens += 1;
    this.openCount += 1;
    this.maxConcurrentOpens = Math.max(
      this.maxConcurrentOpens,
      this.#activeOpens,
    );
    if (this.openDelayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, this.openDelayMs);
      });
    }
    const version =
      this.versions[Math.min(this.#next, this.versions.length - 1)];
    this.#next += 1;
    this.#activeOpens -= 1;
    if (version === undefined) {
      throw new Error("The fake repository has no version.");
    }
    return new FakeSession(version);
  }
}

interface Harness {
  readonly store: ReviewStore;
  readonly service: ReviewService;
  readonly repository: FakeRepository;
  close(): Promise<void>;
}

async function createHarness(
  versions: readonly Version[],
  options: {
    readonly warningLineCount?: number;
    readonly archiveRetention?: number;
    readonly openDelayMs?: number;
    readonly failIndex?: { value: boolean };
  } = {},
): Promise<Harness> {
  const storageRoot = path.join(workRoot, randomUUID());
  usedDirectories.add(storageRoot);
  await mkdir(storageRoot, { recursive: true });
  const store = await ReviewStore.open({
    storageRoot,
    canonicalRepositoryRoot,
    environment: "test",
    ...(options.archiveRetention === undefined
      ? {}
      : { archiveRetention: options.archiveRetention }),
    ...(options.failIndex === undefined
      ? {}
      : {
          faultInjector: (point) => {
            if (point === "before-index-rename" && options.failIndex?.value === true) {
              options.failIndex.value = false;
              throw new Error("simulated write failure");
            }
          },
        }),
  });
  const repository = new FakeRepository(versions, options.openDelayMs);
  const ids = deterministicIds();
  let tick = 0;
  const service = new ReviewService({
    canonicalRepositoryRoot,
    environment: "test",
    store,
    repository,
    warningLineCount: options.warningLineCount ?? 10_000,
    uuid: ids,
    clock: () => new Date(Date.UTC(2026, 7, 25, 20, tick++)),
  });
  return {
    store,
    service,
    repository,
    close: async () => store.close(),
  };
}

describe("review lifecycle", () => {
  it("starts Last 1 and Last X reviews with stable names and root truncation", async () => {
    const lastOne = version(["change-a"], ["commit-a"], "Newest subject");
    const harness = await createHarness([lastOne]);
    try {
      await expect(
        harness.service.startReview({ requestedChangeCount: 0 }),
      ).rejects.toMatchObject({ code: "invalid-change-count" });
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      expect(started.actualChangeCount).toBe(1);
      expect(started.record.review.name).toBe(
        "Newest subject — 2026-08-25 20:00 UTC",
      );
      expect(started.record.review.orderedChangeIds).toEqual(["change-a"]);

      await harness.service.archiveActiveReview();
      const lastX = await harness.service.startReview({
        requestedChangeCount: 4,
      });
      expect(lastX.actualChangeCount).toBe(1);
      expect(lastX.truncatedAtRoot).toBe(true);
      expect(lastX.record.review.requestedChangeCount).toBe(4);
    } finally {
      await harness.close();
    }
  });

  it("requires an explicit archive-and-start and commits both states atomically", async () => {
    const harness = await createHarness([
      version(["change-a"], ["commit-a"], "First"),
      version(["change-b"], ["commit-b"], "Second"),
    ]);
    try {
      const first = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      await expect(
        harness.service.startReview({ requestedChangeCount: 1 }),
      ).rejects.toBeInstanceOf(ActiveReviewConflictError);
      expect(harness.repository.openCount).toBe(1);

      const second = await harness.service.archiveAndStartReview({
        requestedChangeCount: 1,
      });
      expect((await harness.service.getActiveReview()).review.id).toBe(
        second.record.review.id,
      );
      expect((await harness.service.getReview(first.record.review.id)).review.state).toBe(
        "archived",
      );
    } finally {
      await harness.close();
    }
  });

  it("starts a historical range with stable IDs and selection metadata", async () => {
    const selected = version(
      ["change-a", "change-b"],
      ["commit-a", "commit-b"],
      "Historical head",
    );
    const harness = await createHarness([selected]);
    try {
      const session = await harness.service.beginStartReview();
      const preview = await session.selectRange("change-a", "change-b");
      const started = await session.start(preview);

      expect(started.record.review.selectionMode).toBe("range");
      expect(started.record.review.requestedChangeCount).toBe(2);
      expect(started.record.review.orderedChangeIds).toEqual([
        "change-a",
        "change-b",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("rejects previews from another session or a changed repository operation", async () => {
    const selected = version(["change-a"], ["commit-a"], "Selected");
    const harness = await createHarness([selected, selected]);
    try {
      const firstSession = await harness.service.beginStartReview();
      const secondSession = await harness.service.beginStartReview();
      const preview = await firstSession.selectLast(1);

      await expect(secondSession.start(preview)).rejects.toMatchObject({
        code: "stale-review",
      });

      harness.repository.currentOperationId = "f".repeat(128);
      await expect(firstSession.start(preview)).rejects.toThrow(
        "repository changed",
      );
      await expect(harness.service.getActiveReview()).rejects.toBeInstanceOf(
        NoActiveReviewError,
      );
    } finally {
      await harness.close();
    }
  });

  it("returns a typed large-diff requirement before persistence", async () => {
    const harness = await createHarness(
      [version(["change-a"], ["commit-a"], "Large")],
      { warningLineCount: 0 },
    );
    try {
      await expect(
        harness.service.startReview({ requestedChangeCount: 1 }),
      ).rejects.toMatchObject({
        code: "confirmation-required",
        changedLineCount: 2,
      } satisfies Partial<LargeDiffConfirmationRequiredError>);
      await expect(harness.service.getActiveReview()).rejects.toBeInstanceOf(
        NoActiveReviewError,
      );

      await expect(
        harness.service.startReview({
          requestedChangeCount: 1,
          confirmLargeDiff: true,
        }),
      ).resolves.toMatchObject({ actualChangeCount: 1 });
    } finally {
      await harness.close();
    }
  });

  it("skips unchanged refreshes and captures rewritten stable change IDs", async () => {
    const initial = version(["change-a"], ["commit-a"], "Initial");
    const rewritten = version(["change-a"], ["commit-b"], "Rewritten", {
      oldText: "old",
      newText: "rewritten",
    });
    const harness = await createHarness([initial, initial, rewritten]);
    const events: string[] = [];
    harness.service.subscribe(({ type }) => events.push(type));
    try {
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      const noOp = await harness.service.refreshReview();
      expect(noOp.changed).toBe(false);
      expect(noOp.record.review.currentSnapshotId).toBe(
        started.record.review.currentSnapshotId,
      );

      const changed = await harness.service.refreshReview();
      expect(changed.changed).toBe(true);
      expect(changed.record.review.snapshotIds).toHaveLength(2);
      expect(
        changed.record.snapshots.at(-1)?.changes[0]?.commitId,
      ).toBe("commit-b");
      expect(events).toEqual(["started", "refreshed"]);
    } finally {
      await harness.close();
    }
  });

  it("includes new direct descendants and updates the active selection atomically", async () => {
    const initial = version(["change-a"], ["commit-a"], "Initial");
    const extended = version(
      ["change-a", "change-b"],
      ["commit-a", "commit-b"],
      "Feedback fix",
      { newText: "fixed" },
    );
    const harness = await createHarness([initial, extended]);
    const events: string[] = [];
    harness.service.subscribe(({ type }) => events.push(type));
    try {
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      const withComment = addFileComment(
        started.record,
        "00000000-0000-4000-8000-000000000099",
      );
      await harness.store.putReview(withComment);
      const result = await harness.service.includeNewChanges();

      expect(result.addedChangeCount).toBe(1);
      expect(result.record.review.orderedChangeIds).toEqual([
        "change-a",
        "change-b",
      ]);
      expect(result.record.review.requestedChangeCount).toBe(1);
      expect(result.record.review.snapshotIds).toHaveLength(2);
      expect(result.record.review.currentSnapshotId).not.toBe(
        started.record.review.currentSnapshotId,
      );
      expect(result.record.snapshots.at(-1)?.orderedChangeIds).toEqual([
        "change-a",
        "change-b",
      ]);
      expect(result.record.review.counts).toEqual({
        open: 1,
        outdated: 0,
        resolved: 0,
      });
      expect(result.record.threads[0]?.anchor).toEqual(
        withComment.threads[0]?.anchor,
      );
      expect(result.record.threads[0]?.messages).toEqual(
        withComment.threads[0]?.messages,
      );
      expect(result.record.threads[0]).toMatchObject({
        currentness: "current",
        projection: {
          snapshotId: result.record.review.currentSnapshotId,
          path: "file.txt",
        },
      });
      expect(events).toEqual(["started", "extended"]);
    } finally {
      await harness.close();
    }
  });

  it("does not mutate or emit when including new changes is rejected", async () => {
    const initial = version(["change-a"], ["commit-a"], "Initial");
    const rejected = version(["other-change"], ["other-commit"], "Unrelated");
    const harness = await createHarness([initial, rejected]);
    const events: string[] = [];
    harness.service.subscribe(({ type }) => events.push(type));
    try {
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      await expect(harness.service.includeNewChanges()).rejects.toMatchObject({
        code: "stale-selection",
      });
      const active = await harness.service.getActiveReview();

      expect(active).toEqual(started.record);
      expect(events).toEqual(["started"]);
    } finally {
      await harness.close();
    }
  });

  it("keeps the current snapshot when a selection is abandoned or divergent", async () => {
    const initial = version(["change-a"], ["commit-a"], "Initial");
    const abandoned = version(["change-a"], ["commit-a"], "Initial", {
      resolveError: new JjStaleSelectionError("The selected change was abandoned."),
    });
    const harness = await createHarness([initial, abandoned]);
    try {
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      await expect(harness.service.refreshReview()).rejects.toMatchObject({
        code: "stale-selection",
      });
      expect((await harness.service.getActiveReview()).review.currentSnapshotId).toBe(
        started.record.review.currentSnapshotId,
      );
      expect((await harness.service.getActiveReview()).snapshots).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("archives, restores, renames, deletes, and keeps archives read-only", async () => {
    const harness = await createHarness([
      version(["change-a"], ["commit-a"], "Lifecycle"),
    ]);
    try {
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      const renamed = await harness.service.renameActiveReview("  Better name  ");
      expect(renamed.review.name).toBe("Better name");
      await harness.service.archiveActiveReview();
      await expect(harness.service.renameActiveReview("No")).rejects.toBeInstanceOf(
        NoActiveReviewError,
      );
      await expect(harness.service.refreshReview()).rejects.toBeInstanceOf(
        NoActiveReviewError,
      );

      const restored = await harness.service.restoreReview(started.record.review.id);
      expect(restored.review.state).toBe("active");
      await harness.service.archiveActiveReview();
      await harness.service.deleteArchivedReview(started.record.review.id);
      await expect(
        harness.service.getReview(started.record.review.id),
      ).rejects.toMatchObject({ code: "review-not-found" });
    } finally {
      await harness.close();
    }
  });

  it("retains only the newest 20 archived reviews", async () => {
    const versions = Array.from({ length: 22 }, (_, index) =>
      version(
        [`change-${String(index)}`],
        [`commit-${String(index)}`],
        `Review ${String(index)}`,
      ),
    );
    const harness = await createHarness(versions);
    try {
      await harness.service.startReview({ requestedChangeCount: 1 });
      for (let index = 1; index < 22; index += 1) {
        await harness.service.archiveAndStartReview({
          requestedChangeCount: 1,
        });
      }
      await harness.service.archiveActiveReview();
      const history = await harness.service.listHistory();
      expect(history).toHaveLength(20);
      expect(history[0]?.review.name).toContain("Review 21");
    } finally {
      await harness.close();
    }
  });

  it("serializes concurrent mutations per repository", async () => {
    const harness = await createHarness(
      [
        version(["change-a"], ["commit-a"], "First"),
        version(["change-b"], ["commit-b"], "Second"),
      ],
      { openDelayMs: 20 },
    );
    try {
      await Promise.all([
        harness.service.archiveAndStartReview({ requestedChangeCount: 1 }),
        harness.service.archiveAndStartReview({ requestedChangeCount: 1 }),
      ]);
      expect(harness.repository.maxConcurrentOpens).toBe(1);
      expect(await harness.service.listHistory()).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("maps file comments through an unambiguous rename", async () => {
    const initial = version(["change-a"], ["commit-a"], "Initial");
    const renamed = renameVersion(["change-a"], ["commit-b"], "Renamed");
    const harness = await createHarness([initial, renamed]);
    try {
      const started = await harness.service.startReview({
        requestedChangeCount: 1,
      });
      await harness.store.putReview(
        addFileComment(started.record, deterministicIds()()),
      );
      const refreshed = await harness.service.refreshReview();
      expect(refreshed.record.threads[0]).toMatchObject({
        currentness: "current",
        projection: {
          snapshotId: refreshed.record.review.currentSnapshotId,
          path: "renamed.txt",
          target: { kind: "file" },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("emits no change event when persistence fails", async () => {
    const failure = { value: false };
    const harness = await createHarness(
      [version(["change-a"], ["commit-a"], "Failure")],
      { failIndex: failure },
    );
    const events: string[] = [];
    harness.service.subscribe(({ type }) => events.push(type));
    try {
      failure.value = true;
      await expect(
        harness.service.startReview({ requestedChangeCount: 1 }),
      ).rejects.toThrow("simulated write failure");
      expect(events).toEqual([]);
      await expect(harness.service.getActiveReview()).rejects.toBeInstanceOf(
        NoActiveReviewError,
      );
    } finally {
      await harness.close();
    }
  });
});

function version(
  changeIds: readonly string[],
  commitIds: readonly string[],
  newestSubject: string,
  options: {
    readonly oldText?: string;
    readonly newText?: string;
    readonly resolveError?: Error;
  } = {},
): Version {
  const oldText = options.oldText ?? "old";
  const newText = options.newText ?? "new";
  const commits: JjCommit[] = changeIds.map((changeId, index) => ({
    changeId,
    normalChangeId: String(index).padStart(32, "0"),
    commitId: commitIds[index] ?? `commit-${String(index)}`,
    parentCommitIds: [index === 0 ? "base" : (commitIds[index - 1] ?? "base")],
    description: index === changeIds.length - 1 ? newestSubject : `Change ${String(index)}`,
    subject: index === changeIds.length - 1 ? newestSubject : `Change ${String(index)}`,
    conflict: false,
    divergent: false,
    root: false,
    currentWorkingCopy: index === changeIds.length - 1,
  }));
  const selection = selectionFrom(commits);
  const allCommitIds = new Set([
    selection.baseCommitId,
    ...selection.commitIds,
  ]);
  const files = new Map<string, readonly JjFile[]>();
  const contents = new Map<string, Buffer>();
  for (const commitId of allCommitIds) {
    files.set(commitId, [file("file.txt")]);
    contents.set(
      `${commitId}\0file.txt`,
      Buffer.from(commitId === selection.headCommitId ? `${newText}\n` : `${oldText}\n`),
    );
  }
  return {
    selection,
    patch: modificationPatch("file.txt", "file.txt", oldText, newText),
    files,
    contents,
    operation: operation(`operation-${commitIds.join("-")}`),
    ...(options.resolveError === undefined
      ? {}
      : { resolveError: options.resolveError }),
  };
}

function renameVersion(
  changeIds: readonly string[],
  commitIds: readonly string[],
  subject: string,
): Version {
  const base = version(changeIds, commitIds, subject);
  const files = new Map(base.files);
  files.set(base.selection.baseCommitId, [file("file.txt")]);
  files.set(base.selection.headCommitId, [file("renamed.txt")]);
  const contents = new Map<string, Buffer>([
    [`${base.selection.baseCommitId}\0file.txt`, Buffer.from("old\n")],
    [`${base.selection.headCommitId}\0renamed.txt`, Buffer.from("old\n")],
  ]);
  return {
    ...base,
    patch: [
      "diff --git a/file.txt b/renamed.txt",
      "similarity index 100%",
      "rename from file.txt",
      "rename to renamed.txt",
      "",
    ].join("\n"),
    files,
    contents,
  };
}

function selectionFrom(commits: readonly JjCommit[]): ReviewSelection {
  const oldest = commits[0];
  const newest = commits.at(-1);
  if (oldest === undefined || newest === undefined) {
    throw new Error("A fake selection must contain a commit.");
  }
  return {
    operationId: `operation-${commits.map(({ commitId }) => commitId).join("-")}`,
    requestedCount: commits.length,
    actualCount: commits.length,
    truncatedAtRoot: false,
    commits,
    changeIds: commits.map(({ changeId }) => changeId),
    commitIds: commits.map(({ commitId }) => commitId),
    baseCommitId: oldest.parentCommitIds[0] ?? "base",
    headCommitId: newest.commitId,
  };
}

function operation(id: string): JjOperation {
  return {
    id,
    parentIds: [],
    description: "test operation",
    timestamp: "2026-08-25T20:00:00.000Z",
    snapshot: true,
    root: false,
  };
}

function file(filePath: string): JjFile {
  return {
    path: filePath,
    fileType: "file",
    executable: false,
    conflict: false,
  };
}

function modificationPatch(
  originalPath: string,
  currentPath: string,
  oldText: string,
  newText: string,
): string {
  return [
    `diff --git a/${originalPath} b/${currentPath}`,
    "index 1111111..2222222 100644",
    `--- a/${originalPath}`,
    `+++ b/${currentPath}`,
    "@@ -1 +1 @@",
    `-${oldText}`,
    `+${newText}`,
    "",
  ].join("\n");
}

function deterministicIds(): () => string {
  let next = 1;
  return () =>
    `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function addFileComment(record: ReviewRecord, commentId: string): ReviewRecord {
  const snapshot = record.snapshots[0];
  if (snapshot === undefined) {
    throw new Error("The test review has no snapshot.");
  }
  return {
    ...record,
    review: {
      ...record.review,
      counts: { open: 1, outdated: 0, resolved: 0 },
    },
    threads: [
      {
        commentId,
        reviewId: record.review.id,
        anchor: {
          snapshotId: snapshot.id,
          view: { mode: "combined" },
          target: { kind: "file" },
          originalPath: "file.txt",
          currentPath: "file.txt",
          fileStatus: "modified",
          targetText: null,
          storedHunk: null,
          contextFingerprint: "0".repeat(64),
        },
        projection: {
          snapshotId: snapshot.id,
          view: { mode: "combined" },
          path: "file.txt",
          target: { kind: "file" },
        },
        state: "open",
        currentness: "current",
        createdAt: record.review.createdAt,
        updatedAt: record.review.updatedAt,
        resolvedAt: null,
        messages: [
          {
            id: randomUUID(),
            author: "user",
            displayName: "Reviewer",
            body: "File comment",
            createdAt: record.review.createdAt,
            updatedAt: record.review.updatedAt,
          },
        ],
      },
    ],
  };
}
