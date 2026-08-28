import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewRecord } from "../../src/domain/comments";
import type {
  FileKind,
  FileManifestEntry,
  FileStatus,
  Snapshot,
} from "../../src/domain/review";
import {
  CommentConflictError,
  CommentService,
  DuplicateCommentError,
  ImmutableCommentError,
  InvalidCommentAnchorError,
  InvalidCommentAuthorError,
  StaleCommentError,
  projectCommentThreads,
} from "../../src/review";
import { ReviewStore, type StorageFaultInjector } from "../../src/storage";
import { makeReviewRecord } from "./storageFixtures";

const workRoot = path.resolve(".test-work", "comment-service");
const repositoryRoot = path.resolve(".test-work", "comment-repository");
const usedDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...usedDirectories].map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  usedDirectories.clear();
});

describe("comment service anchors", () => {
  it("creates file threads for every status and file kind", async () => {
    const combinations: readonly [FileStatus, FileKind][] = [
      ["added", "text"],
      ["modified", "binary"],
      ["deleted", "symbolic-link"],
      ["renamed", "non-regular"],
      ["copied", "text"],
    ];
    const files = combinations.map(([status, kind], index) =>
      makeFile(`file-${String(index)}`, status, kind),
    );
    const harness = await createHarness({ files });
    try {

      for (const file of files) {
        const thread = await harness.service.createThread({
          reviewId: harness.record.review.id,
          snapshotId: harness.record.review.currentSnapshotId,
          view: { mode: "combined" },
          fileId: file.fileId,
          target: { kind: "file" },
          body: `Review ${file.fileId}`,
          displayName: "Reviewer",
        });
        expect(thread.anchor).toMatchObject({
          reviewId: harness.record.review.id,
          fileId: file.fileId,
          fileStatus: file.status,
          target: { kind: "file" },
        });
        expect(thread.projection?.path).toBe(
          file.currentPath ?? file.originalPath,
        );
      }
    } finally {
      await harness.close();
    }
  });

  it("accepts new-side text lines and rejects invalid sides and file kinds", async () => {
    const deleted = makeFile("deleted", "deleted", "text");
    const binary = makeFile("binary", "modified", "binary");
    const harness = await createHarness({
      files: [lineFile("line-file"), deleted, binary],
      modifiedContents: new Map([
        ["line-file", "same\nnew\nunchanged\n"],
      ]),
    });
    try {
      const base = {
        reviewId: harness.record.review.id,
        snapshotId: harness.record.review.currentSnapshotId,
        view: { mode: "combined" } as const,
        fileId: "line-file",
        body: "Line note",
        displayName: "Reviewer",
      };

      await expect(
        harness.service.createThread({ ...base, target: { kind: "line", line: 1 } }),
      ).resolves.toMatchObject({ anchor: { targetText: "same" } });
      await expect(
        harness.service.createThread({ ...base, target: { kind: "line", line: 2 } }),
      ).resolves.toMatchObject({ anchor: { targetText: "new" } });
      await expect(
        harness.service.createThread({ ...base, target: { kind: "line", line: 3 } }),
      ).resolves.toMatchObject({
        anchor: { targetText: "unchanged", storedHunk: null },
      });
      await expect(
        harness.service.createThread({ ...base, target: { kind: "line", line: 99 } }),
      ).rejects.toBeInstanceOf(InvalidCommentAnchorError);
      await expect(
        harness.service.createThread({
          ...base,
          side: "old",
          target: { kind: "line", line: 2 },
        }),
      ).rejects.toBeInstanceOf(InvalidCommentAnchorError);
      await expect(
        harness.service.createThread({
          ...base,
          fileId: binary.fileId,
          target: { kind: "line", line: 1 },
        }),
      ).rejects.toBeInstanceOf(InvalidCommentAnchorError);
      await expect(
        harness.service.createThread({
          ...base,
          snapshotId: randomUUID(),
          target: { kind: "line", line: 1 },
        }),
      ).rejects.toBeInstanceOf(StaleCommentError);
      await expect(
        harness.service.createThread({
          ...base,
          snapshotId: harness.record.review.currentSnapshotId,
          fileId: deleted.fileId,
          target: { kind: "line", line: 1 },
        }),
      ).rejects.toBeInstanceOf(InvalidCommentAnchorError);
    } finally {
      await harness.close();
    }
  });

  it("creates and exactly projects a line anchor outside displayed hunks", async () => {
    const file = lineFile("line-file");
    const originalContent = "same\nnew\nbefore\noutside\nafter\n";
    const harness = await createHarness({
      files: [file],
      modifiedContents: new Map([[file.fileId, originalContent]]),
    });
    try {
      const thread = await harness.service.createThread({
        reviewId: harness.record.review.id,
        snapshotId: harness.record.review.currentSnapshotId,
        view: { mode: "combined" },
        fileId: file.fileId,
        target: { kind: "line", line: 4 },
        body: "Review this unchanged line.",
        displayName: "Reviewer",
      });
      expect(thread.anchor).toMatchObject({
        targetText: "outside",
        storedHunk: null,
        fullFileContext: {
          targetIndex: 3,
          lines: ["same", "new", "before", "outside", "after", ""],
        },
      });

      const shiftedContent = "prefix\nsame\nnew\nbefore\noutside\nafter\n";
      const shiftedReference = await harness.store.blobs.put(
        Buffer.from(shiftedContent),
      );
      const latest = await harness.store.getReview(harness.record.review.id);
      const shiftedFile = {
        ...lineFile("shifted"),
        currentPath: "file.txt",
        modifiedContent: shiftedReference,
      };
      const projected = await projectCommentThreads({
        previous: latest,
        nextSnapshot: nextSnapshot(latest, [shiftedFile]),
        defaultFileProjections: [],
        readBlob: async (reference) => harness.store.blobs.get(reference),
      });
      expect(projected[0]).toMatchObject({
        currentness: "current",
        projection: { target: { kind: "line", line: 5 } },
      });
    } finally {
      await harness.close();
    }
  });

  it("validates plain text, body size, and human identity", async () => {
    const harness = await createHarness();
    try {
      const input = createInput(harness.record);
      await expect(
        harness.service.createThread({ ...input, body: " \n\t " }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        harness.service.createThread({ ...input, body: "bad\u0000body" }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        harness.service.createThread({
          ...input,
          body: "x".repeat(65_537),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        harness.service.createThread({ ...input, displayName: "Agent" }),
      ).rejects.toBeInstanceOf(InvalidCommentAuthorError);
    } finally {
      await harness.close();
    }
  });
});

describe("comment service actions", () => {
  it("enforces human and Agent permissions through the thread lifecycle", async () => {
    const harness = await createHarness();
    try {
      const thread = await harness.service.createThread(createInput(harness.record));
      const human = await harness.service.reply({
        reviewId: thread.reviewId,
        commentId: thread.commentId,
        body: "Human reply",
        displayName: "Reviewer",
      });
      const agent = await harness.service.replyAsAgent({
        reviewId: thread.reviewId,
        commentId: thread.commentId,
        body: "Agent reply",
      });
      await expect(
        harness.service.editMessage({
          reviewId: thread.reviewId,
          commentId: thread.commentId,
          messageId: agent.id,
          body: "Changed",
        }),
      ).rejects.toBeInstanceOf(ImmutableCommentError);
      await expect(
        harness.service.deleteMessage({
          reviewId: thread.reviewId,
          commentId: thread.commentId,
          messageId: agent.id,
        }),
      ).rejects.toBeInstanceOf(ImmutableCommentError);

      const edited = await harness.service.editMessage({
        reviewId: thread.reviewId,
        commentId: thread.commentId,
        messageId: human.id,
        body: "Edited human reply",
      });
      expect(edited.body).toBe("Edited human reply");
      await harness.service.resolve({
        reviewId: thread.reviewId,
        commentId: thread.commentId,
      });
      await expect(
        harness.service.replyAsAgent({
          reviewId: thread.reviewId,
          commentId: thread.commentId,
          body: "Too late",
        }),
      ).rejects.toBeInstanceOf(CommentConflictError);
      await harness.service.reopen({
        reviewId: thread.reviewId,
        commentId: thread.commentId,
      });
      await expect(
        harness.service.reply({
          reviewId: thread.reviewId,
          commentId: thread.commentId,
          body: "Open again",
          displayName: "Reviewer",
        }),
      ).resolves.toMatchObject({ author: "user" });
    } finally {
      await harness.close();
    }
  });

  it("removes only an empty thread and retains all other audit messages", async () => {
    const harness = await createHarness();
    try {
      const thread = await harness.service.createThread(createInput(harness.record));
      const firstMessage = thread.messages[0];
      if (firstMessage === undefined) {
        throw new Error("The thread has no first message.");
      }
      await harness.service.replyAsAgent({
        reviewId: thread.reviewId,
        commentId: thread.commentId,
        body: "Permanent agent audit",
      });
      await expect(
        harness.service.deleteMessage({
          reviewId: thread.reviewId,
          commentId: thread.commentId,
          messageId: firstMessage.id,
        }),
      ).resolves.toEqual({ threadRemoved: false });
      expect(
        (await harness.service.queryActiveThreads()).items[0]?.messages,
      ).toHaveLength(1);

      const second = await harness.service.createThread({
        ...createInput(harness.record),
        body: "Temporary",
      });
      const onlyMessage = second.messages[0];
      if (onlyMessage === undefined) {
        throw new Error("The second thread has no message.");
      }
      await expect(
        harness.service.deleteMessage({
          reviewId: second.reviewId,
          commentId: second.commentId,
          messageId: onlyMessage.id,
        }),
      ).resolves.toEqual({ threadRemoved: true });
    } finally {
      await harness.close();
    }
  });

  it("keeps archives read-only and permits writes after restore", async () => {
    const harness = await createHarness();
    try {
      const archivedAt = "2026-08-25T22:00:00.000Z";
      await harness.store.updateReview(harness.record.review.id, (record) => ({
        ...record,
        review: {
          ...record.review,
          state: "archived",
          archivedAt,
          updatedAt: archivedAt,
        },
      }));
      await expect(
        harness.service.createThread(createInput(harness.record)),
      ).rejects.toBeInstanceOf(CommentConflictError);

      await harness.store.updateReview(harness.record.review.id, (record) => ({
        ...record,
        review: {
          ...record.review,
          state: "active",
          archivedAt: null,
          updatedAt: "2026-08-25T22:01:00.000Z",
        },
      }));
      await expect(
        harness.service.createThread(createInput(harness.record)),
      ).resolves.toMatchObject({ state: "open" });
    } finally {
      await harness.close();
    }
  });

  it("validates an Agent resolution batch before changing any thread", async () => {
    const harness = await createHarness();
    try {
      const first = await harness.service.createThread(createInput(harness.record));
      const second = await harness.service.createThread({
        ...createInput(harness.record),
        body: "Second",
      });
      await harness.service.resolveAsAgent({
        reviewId: second.reviewId,
        commentId: second.commentId,
        note: "Done",
      });
      expect(
        (await harness.service.queryActiveThreads({ status: "resolved" })).items[0]
          ?.messages.at(-1),
      ).toMatchObject({ author: "agent", displayName: "Agent", body: "Done" });

      await expect(
        harness.service.resolveBatchAsAgent({
          reviewId: first.reviewId,
          items: [
            { commentId: first.commentId },
            { commentId: second.commentId },
          ],
        }),
      ).rejects.toBeInstanceOf(CommentConflictError);
      expect(
        (await harness.service.queryActiveThreads({ status: "all" })).items.find(
          ({ commentId }) => commentId === first.commentId,
        )?.state,
      ).toBe("open");

      await expect(
        harness.service.resolveBatchAsAgent({
          reviewId: first.reviewId,
          items: [
            { commentId: first.commentId },
            { commentId: first.commentId },
          ],
        }),
      ).rejects.toBeInstanceOf(DuplicateCommentError);

      const archived = makeReviewRecord(harness.store.fingerprint, {
        state: "archived",
      });
      await harness.store.putReview(archived);
      const foreign = archived.threads[0];
      if (foreign === undefined) {
        throw new Error("The archived review has no thread.");
      }
      await expect(
        harness.service.resolveBatchAsAgent({
          reviewId: first.reviewId,
          items: [{ commentId: foreign.commentId }],
        }),
      ).rejects.toBeInstanceOf(CommentConflictError);
      expect(
        (await harness.service.queryActiveThreads()).items.find(
          ({ commentId }) => commentId === first.commentId,
        )?.state,
      ).toBe("open");

      const resolved = await harness.service.resolveBatchAsAgent({
        reviewId: first.reviewId,
        items: [{ commentId: first.commentId, note: "Batch done" }],
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        commentId: first.commentId,
        state: "resolved",
      });
      expect(resolved[0]?.messages.at(-1)).toMatchObject({
        author: "agent",
        body: "Batch done",
      });
    } finally {
      await harness.close();
    }
  });

  it("serializes concurrent writes and emits only after persistence succeeds", async () => {
    const harness = await createHarness();
    try {
      const thread = await harness.service.createThread(createInput(harness.record));
      await Promise.all(
        ["one", "two", "three"].map(async (body) =>
          harness.service.reply({
            reviewId: thread.reviewId,
            commentId: thread.commentId,
            body,
            displayName: "Reviewer",
          }),
        ),
      );
      expect((await harness.service.queryActiveThreads()).items[0]?.messages).toHaveLength(
        4,
      );
    } finally {
      await harness.close();
    }

    const failure = { enabled: false };
    const failed = await createHarness({
      faultInjector: (point) => {
        if (point === "before-index-rename" && failure.enabled) {
          failure.enabled = false;
          throw new Error("persist failed");
        }
      },
    });
    const listener = vi.fn();
    failed.service.subscribe(listener);
    try {
      failure.enabled = true;
      await expect(
        failed.service.createThread(createInput(failed.record)),
      ).rejects.toThrow("persist failed");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      await failed.close();
    }
  });
});

describe("comment queries and projection", () => {
  it("filters active and history threads with stable bounded pagination", async () => {
    const harness = await createHarness();
    try {
      const first = await harness.service.createThread(createInput(harness.record));
      const second = await harness.service.createThread({
        ...createInput(harness.record),
        body: "Second",
      });
      const third = await harness.service.createThread({
        ...createInput(harness.record),
        body: "Third",
      });
      await harness.service.resolve({
        reviewId: second.reviewId,
        commentId: second.commentId,
      });

      const page = await harness.service.queryActiveThreads({
        status: "all",
        limit: 2,
      });
      expect(page.items.map(({ commentId }) => commentId)).toEqual([
        first.commentId,
        second.commentId,
      ]);
      expect(page.nextCursor).not.toBeNull();
      if (page.nextCursor === null) {
        throw new Error("The first page has no cursor.");
      }
      await expect(
        harness.service.queryActiveThreads({
          status: "all",
          cursor: page.nextCursor,
          limit: 2,
        }),
      ).resolves.toMatchObject({
        items: [{ commentId: third.commentId }],
        nextCursor: null,
      });
      await expect(
        harness.service.queryActiveThreads({ status: "resolved" }),
      ).resolves.toMatchObject({ items: [{ commentId: second.commentId }] });
      await expect(
        harness.service.queryActiveThreads({ ids: [first.commentId] }),
      ).resolves.toMatchObject({ items: [{ commentId: first.commentId }] });
      expect(
        (await harness.service.queryActiveThreads({ file: "file.txt" })).items,
      ).toHaveLength(2);

      await harness.store.updateReview(harness.record.review.id, (record) => ({
        ...record,
        review: {
          ...record.review,
          updatedAt: "2026-08-25T22:00:00.000Z",
          counts: { open: 1, outdated: 1, resolved: 1 },
        },
        threads: record.threads.map((thread) =>
          thread.commentId === first.commentId
            ? {
                ...thread,
                currentness: "outdated" as const,
                projection: null,
                updatedAt: "2026-08-25T22:00:00.000Z",
              }
            : thread,
        ),
      }));
      expect(
        (await harness.service.queryActiveThreads()).items.map(
          ({ commentId }) => commentId,
        ),
      ).toEqual([first.commentId, third.commentId]);

      await harness.store.updateReview(harness.record.review.id, (record) => ({
        ...record,
        review: {
          ...record.review,
          state: "archived",
          archivedAt: "2026-08-25T22:01:00.000Z",
          updatedAt: "2026-08-25T22:01:00.000Z",
        },
      }));
      const history = await harness.service.queryHistoryThreads({
        status: "all",
        outdated: true,
      });
      expect(history.items.map(({ commentId }) => commentId)).toEqual([
        first.commentId,
      ]);
    } finally {
      await harness.close();
    }
  });

  it("maps exact context and renames, but rejects ambiguity and view crossover", async () => {
    const harness = await createHarness({ files: [lineFile("line-file")] });
    try {
      const thread = await harness.service.createThread({
        ...createInput(harness.record),
        fileId: "line-file",
        target: { kind: "line", line: 2 },
      });
      const latest = await harness.store.getReview(harness.record.review.id);
      const nextLineFile = lineFile("next-line");
      const nextLineHunk = nextLineFile.hunks[0];
      if (nextLineHunk === undefined) {
        throw new Error("The next line file has no hunk.");
      }
      const renamed = nextSnapshot(latest, [
        {
          ...nextLineFile,
          status: "renamed",
          originalPath: "file.txt",
          currentPath: "renamed.txt",
          hunks: [
            {
              ...nextLineHunk,
              oldStart: 10,
              newStart: 10,
              lines: nextLineHunk.lines.map((line) => ({
                ...line,
                oldLine: line.oldLine === null ? null : line.oldLine + 9,
                newLine: line.newLine === null ? null : line.newLine + 9,
              })),
            },
          ],
        },
      ]);
      const projected = await projectCommentThreads({
        previous: latest,
        nextSnapshot: renamed,
        defaultFileProjections: [],
        readBlob: () => Promise.resolve(Buffer.alloc(0)),
      });
      expect(projected[0]).toMatchObject({
        currentness: "current",
        projection: {
          path: "renamed.txt",
          target: { kind: "line", line: 11 },
        },
      });
      expect(projected[0]?.anchor).toEqual(thread.anchor);

      const ambiguous = nextSnapshot(latest, [
        lineFile("a"),
        { ...lineFile("b"), currentPath: "other.txt" },
      ]);
      expect(
        (await projectCommentThreads({
          previous: latest,
          nextSnapshot: ambiguous,
          defaultFileProjections: [],
          readBlob: () => Promise.resolve(Buffer.alloc(0)),
        }))[0],
      ).toMatchObject({ currentness: "outdated", projection: null });

      const changedContextFile = lineFile("changed-context");
      const changedContextHunk = changedContextFile.hunks[0];
      if (changedContextHunk === undefined) {
        throw new Error("The changed context file has no hunk.");
      }
      const changedContext = nextSnapshot(latest, [
        {
          ...changedContextFile,
          hunks: [
            {
              ...changedContextHunk,
              lines: changedContextHunk.lines.map((line, index) =>
                index === 0 ? { ...line, content: "different" } : line,
              ),
            },
          ],
        },
      ]);
      expect(
        (await projectCommentThreads({
          previous: latest,
          nextSnapshot: changedContext,
          defaultFileProjections: [],
          readBlob: () => Promise.resolve(Buffer.alloc(0)),
        }))[0],
      ).toMatchObject({ currentness: "outdated", projection: null });

      const crossed = nextSnapshot(latest, [], [
        {
          ...lineFile("per-change-only"),
          currentPath: "file.txt",
        },
      ]);
      expect(
        (await projectCommentThreads({
          previous: latest,
          nextSnapshot: crossed,
          defaultFileProjections: [],
          readBlob: () => Promise.resolve(Buffer.alloc(0)),
        }))[0],
      ).toMatchObject({ currentness: "outdated", projection: null });
    } finally {
      await harness.close();
    }
  });
});

interface Harness {
  readonly store: ReviewStore;
  readonly service: CommentService;
  readonly record: ReviewRecord;
  close(): Promise<void>;
}

async function createHarness(
  options: {
    readonly faultInjector?: StorageFaultInjector;
    readonly files?: readonly FileManifestEntry[];
    readonly modifiedContents?: ReadonlyMap<string, string>;
  } = {},
): Promise<Harness> {
  const storageRoot = path.join(workRoot, randomUUID());
  usedDirectories.add(storageRoot);
  await mkdir(storageRoot, { recursive: true });
  const store = await ReviewStore.open({
    storageRoot,
    canonicalRepositoryRoot: repositoryRoot,
    environment: "comment-test",
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector }),
  });
  const empty = emptyRecord(makeReviewRecord(store.fingerprint));
  const files =
    options.files === undefined
      ? undefined
      : await Promise.all(
          options.files.map(async (file) => {
            const content = options.modifiedContents?.get(file.fileId);
            return content === undefined
              ? file
              : {
                  ...file,
                  modifiedContent: await store.blobs.put(Buffer.from(content)),
                };
          }),
        );
  const record = files === undefined ? empty : withFiles(empty, files);
  await store.putReview(record);
  let tick = 0;
  const service = new CommentService({
    store,
    uuid: deterministicIds(),
    clock: () => new Date(Date.UTC(2026, 7, 25, 21, 0, tick++)),
  });
  return {
    store,
    service,
    record,
    close: async () => store.close(),
  };
}

function emptyRecord(record: ReviewRecord): ReviewRecord {
  return {
    ...record,
    review: {
      ...record.review,
      counts: { open: 0, outdated: 0, resolved: 0 },
    },
    threads: [],
  };
}

function createInput(record: ReviewRecord) {
  const file = record.snapshots[0]?.views[0]?.files[0];
  if (file === undefined) {
    throw new Error("The record has no file.");
  }
  return {
    reviewId: record.review.id,
    snapshotId: record.review.currentSnapshotId,
    view: { mode: "combined" } as const,
    fileId: file.fileId,
    target: { kind: "file" } as const,
    body: "Please review this.",
    displayName: "Reviewer",
  };
}

function withFiles(
  record: ReviewRecord,
  files: readonly FileManifestEntry[],
): ReviewRecord {
  return {
    ...record,
    snapshots: record.snapshots.map((snapshot) => ({
      ...snapshot,
      views: snapshot.views.map((view) => ({
        ...view,
        files: files.map((file) => structuredClone(file)),
      })),
    })),
  };
}

function makeFile(
  fileId: string,
  status: FileStatus,
  kind: FileKind,
): FileManifestEntry {
  const content = {
    sha256: "0".repeat(64),
    byteLength: 0,
    encoding: "gzip" as const,
  };
  const originalPath = status === "added" ? null : "file.txt";
  const currentPath = status === "deleted" ? null : `${fileId}.txt`;
  const contentRequired = kind === "text" || kind === "symbolic-link";
  return {
    fileId,
    status,
    kind,
    originalPath,
    currentPath,
    originalContent:
      contentRequired && status !== "added" ? content : null,
    modifiedContent:
      contentRequired && status !== "deleted" ? content : null,
    patch: null,
    hunks: [],
    addedLines: 0,
    deletedLines: 0,
  };
}

function lineFile(fileId: string): FileManifestEntry {
  const file = makeFile(fileId, "modified", "text");
  return {
    ...file,
    currentPath: "file.txt",
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: "context", content: "same", oldLine: 1, newLine: 1 },
          { kind: "deletion", content: "old", oldLine: 2, newLine: null },
          { kind: "addition", content: "new", oldLine: null, newLine: 2 },
        ],
      },
    ],
    addedLines: 1,
    deletedLines: 1,
  };
}

function nextSnapshot(
  record: ReviewRecord,
  combinedFiles: readonly FileManifestEntry[],
  perChangeFiles: readonly FileManifestEntry[] = combinedFiles,
): Snapshot {
  const current = record.snapshots.find(
    ({ id }) => id === record.review.currentSnapshotId,
  );
  if (current === undefined) {
    throw new Error("The record has no current snapshot.");
  }
  return {
    ...structuredClone(current),
    id: randomUUID(),
    capturedAt: "2026-08-25T23:00:00.000Z",
    views: current.views.map((view) => ({
      ...structuredClone(view),
      files:
        view.identity.mode === "combined"
          ? combinedFiles.map((file) => structuredClone(file))
          : perChangeFiles.map((file) => structuredClone(file)),
    })),
  };
}

function deterministicIds(): () => string {
  let next = 1;
  return () =>
    `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
