import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import type {
  CommentThread as PersistedCommentThread,
  ReviewRecord,
} from "../../src/domain/comments";
import type { ReviewService } from "../../src/review";
import {
  commentableRanges,
  commentPlacements,
  InReviewCommentController,
  resolveCommentDocument,
  type CommentVscodeApi,
} from "../../src/vscode/commentController";
import {
  VirtualDocumentUriCodec,
  type VirtualDocumentIdentity,
} from "../../src/vscode/virtualDocumentProvider";
import { makeReviewRecord } from "./storageFixtures";

const fingerprint = "a".repeat(64);
const key = "comment-controller-test-key";

describe("comment document mapping", () => {
  it("offers complete current text ranges on both stored diff sides", () => {
    const record = recordWithOriginalSide();
    const identity = identityFor(record);

    expect(resolveCommentDocument(record, identity)?.file.fileId).toBe("file-a");
    expect(commentableRanges(record, identity, 20)).toEqual([
      { start: 1, end: 20 },
    ]);
    expect(commentableRanges(record, { ...identity, side: "original" }, 20)).toEqual([
      { start: 1, end: 20 },
    ]);
    expect(
      commentableRanges(
        {
          ...record,
          review: {
            ...record.review,
            state: "archived",
            archivedAt: record.review.updatedAt,
          },
        },
        identity,
        20,
      ),
    ).toEqual([]);
    expect(
      commentableRanges(record, {
        ...identity,
        repositoryPath: "other.txt",
      }, 20),
    ).toEqual([]);
    const added = recordWithRanges();
    expect(
      commentableRanges(
        added,
        { ...identityFor(added), side: "original" },
        20,
      ),
    ).toEqual([]);
  });

  it("offers the original side of a deleted text file", () => {
    const base = recordWithOriginalSide();
    const record: ReviewRecord = {
      ...base,
      snapshots: base.snapshots.map((snapshot) => ({
        ...snapshot,
        views: snapshot.views.map((view) => ({
          ...view,
          files: view.files.map((file) => ({
            ...file,
            status: "deleted" as const,
            currentPath: null,
            modifiedContent: null,
          })),
        })),
      })),
    };
    const original = {
      ...identityFor(record),
      side: "original" as const,
      repositoryPath: "file.txt",
    };

    expect(commentableRanges(record, original, 20)).toEqual([
      { start: 1, end: 20 },
    ]);
    expect(
      commentableRanges(record, { ...original, side: "modified" }, 20),
    ).toEqual([]);
  });

  it("places current threads only at projections and outdated threads at anchors", () => {
    const original = recordWithRanges();
    const oldSnapshot = original.snapshots[0];
    if (oldSnapshot === undefined) {
      throw new Error("Missing fixture snapshot.");
    }
    const newSnapshotId = randomUUID();
    const newSnapshot = {
      ...structuredClone(oldSnapshot),
      id: newSnapshotId,
      views: oldSnapshot.views.map((view) => ({
        ...structuredClone(view),
        files: view.files.map((file) => ({ ...structuredClone(file), fileId: "file-new" })),
      })),
    };
    const currentThread = original.threads[0];
    if (currentThread === undefined) {
      throw new Error("Missing fixture thread.");
    }
    const current: PersistedCommentThread = {
      ...currentThread,
      projection: {
        snapshotId: newSnapshotId,
        view: { mode: "combined" },
        path: "file.txt",
        target: { kind: "line", line: 2 },
      },
    };
    const outdated: PersistedCommentThread = {
      ...structuredClone(currentThread),
      commentId: randomUUID(),
      currentness: "outdated",
      projection: null,
    };
    const record: ReviewRecord = {
      ...original,
      review: {
        ...original.review,
        currentSnapshotId: newSnapshotId,
        snapshotIds: [oldSnapshot.id, newSnapshotId],
        counts: { open: 1, outdated: 1, resolved: 0 },
      },
      snapshots: [oldSnapshot, newSnapshot],
      threads: [current, outdated],
    };

    expect(
      commentPlacements(record, {
        ...identityFor(record),
        snapshotId: newSnapshotId,
        fileId: "file-new",
      }).map(({ thread, line, historical }) => [
        thread.commentId,
        line,
        historical,
      ]),
    ).toEqual([[current.commentId, 2, false]]);
    expect(
      commentPlacements(record, {
        ...identityFor(record),
        snapshotId: oldSnapshot.id,
      }).map(({ thread, line, historical }) => [
        thread.commentId,
        line,
        historical,
      ]),
    ).toEqual([[outdated.commentId, 1, true]]);
  });

  it("places old-side threads only on the original document", () => {
    const base = recordWithOriginalSide();
    const thread = base.threads[0];
    if (thread?.projection == null) {
      throw new Error("Missing fixture thread.");
    }
    const oldThread: PersistedCommentThread = {
      ...structuredClone(thread),
      anchor: {
        ...structuredClone(thread.anchor),
        side: "old",
        originalPath: "file.txt",
      },
      projection: {
        ...structuredClone(thread.projection),
        side: "old",
        path: "file.txt",
      },
    };
    const record = { ...base, threads: [oldThread] };
    const modified = identityFor(record);
    const original = { ...modified, side: "original" as const };

    expect(commentPlacements(record, modified)).toEqual([]);
    expect(commentPlacements(record, original)).toHaveLength(1);
  });
});

describe("VS Code comment adapter", () => {
  it("renders persisted authors and file labels, reuses no-op threads, and disposes", async () => {
    const record = recordWithAgentAndFileComment();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();

    expect(harness.rendered).toHaveLength(2);
    expect(
      harness.rendered[0]?.comments.map(({ author }) => author.name),
    ).toEqual(["You", "Agent"]);
    expect(harness.rendered[1]?.label).toContain(
      "File-level comment (not tied to a source line)",
    );
    const threads = [...harness.rendered];
    const writes = threads.map(({ propertyWrites }) => propertyWrites);

    harness.commentListener?.();
    await adapter.refresh();
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(2);
    expect(harness.rendered).toEqual(threads);
    expect(threads.map(({ propertyWrites }) => propertyWrites)).toEqual(writes);
    expect(threads.map(({ disposeCalls }) => disposeCalls)).toEqual([0, 0]);

    adapter.dispose();
    adapter.dispose();
    expect(harness.controllerDisposed).toHaveBeenCalledOnce();
    expect(harness.rendered.every(({ disposed }) => disposed)).toBe(true);
    expect(threads.map(({ disposeCalls }) => disposeCalls)).toEqual([1, 1]);
  });

  it("persists create, reply, edit, delete, resolve, reopen, and file comments", async () => {
    const record = recordWithOriginalSide();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const rendered = harness.rendered.find(({ disposed }) => !disposed);
    const persistedComment = rendered?.comments[0];
    if (rendered === undefined || persistedComment === undefined) {
      throw new Error("The persisted thread was not rendered.");
    }

    await adapter.submit({ thread: rendered, text: "Reply" });
    expect(harness.commentService.reply).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Reply", displayName: "You" }),
    );

    const originalBody = persistedComment.body;
    adapter.edit(persistedComment);
    persistedComment.body = "Discarded draft";
    adapter.cancelEdit(persistedComment);
    expect(persistedComment.body).toBe(originalBody);

    adapter.edit(persistedComment);
    persistedComment.body = "Edited";
    await adapter.save(persistedComment);
    expect(harness.commentService.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Edited" }),
    );
    await adapter.delete(persistedComment);
    expect(harness.commentService.deleteMessage).toHaveBeenCalledOnce();

    await adapter.resolve(rendered);
    await adapter.reopen(rendered);
    expect(harness.commentService.resolve).toHaveBeenCalledOnce();
    expect(harness.commentService.reopen).toHaveBeenCalledOnce();

    harness.input = "Whole file";
    await adapter.addFileComment(harness.document.uri);
    expect(harness.commentService.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "file" },
        body: "Whole file",
      }),
    );

    const pending = makeRenderedThread(harness.document.uri, [], new TestRange(1, 0, 1, 3));
    await adapter.submit({ thread: pending, text: "New line thread" });
    expect(harness.commentService.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "line", line: 2 },
        body: "New line thread",
      }),
    );
    expect(pending.disposed).toBe(true);

    const originalIdentity = {
      ...identityFor(record),
      side: "original" as const,
    };
    const originalUri = new VirtualDocumentUriCodec(key, {
      from: (components) => TestUri.from(components),
    }).encode(originalIdentity);
    const oldPending = makeRenderedThread(
      originalUri,
      [],
      new TestRange(0, 0, 0, 3),
    );
    await adapter.submit({ thread: oldPending, text: "Old-side thread" });
    expect(harness.commentService.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "line", line: 1 },
        side: "old",
      }),
    );
    adapter.dispose();
  });

  it("reveals current lines and outdated anchor lines in their matching snapshots", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const thread = record.threads[0];
    if (thread === undefined) {
      throw new Error("Missing fixture thread.");
    }

    await adapter.revealComment({
      reviewId: record.review.id,
      commentId: thread.commentId,
    });
    expect(harness.nativeDiff.revealFile).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: record.review.currentSnapshotId,
        fileId: "file-a",
      }),
    );
    expect(harness.editor.revealRange).toHaveBeenCalledOnce();
    adapter.dispose();

    const historical = recordWithRanges();
    const anchorSnapshot = historical.snapshots[0];
    const historicalThread = historical.threads[0];
    if (anchorSnapshot === undefined || historicalThread === undefined) {
      throw new Error("Missing historical fixture data.");
    }
    const currentSnapshotId = randomUUID();
    const outdatedRecord: ReviewRecord = {
      ...historical,
      review: {
        ...historical.review,
        currentSnapshotId,
        snapshotIds: [anchorSnapshot.id, currentSnapshotId],
        counts: { open: 0, outdated: 1, resolved: 0 },
      },
      snapshots: [
        anchorSnapshot,
        { ...structuredClone(anchorSnapshot), id: currentSnapshotId },
      ],
      threads: [
        {
          ...historicalThread,
          currentness: "outdated",
          projection: null,
        },
      ],
    };
    const outdatedHarness = makeHarness(outdatedRecord);
    const outdatedAdapter = new InReviewCommentController({
      service: outdatedHarness.service,
      nativeDiff: outdatedHarness.nativeDiff,
      signingKey: key,
      vscode: outdatedHarness.api,
    });
    await outdatedAdapter.revealComment({
      reviewId: outdatedRecord.review.id,
      commentId: historicalThread.commentId,
    });
    expect(outdatedHarness.nativeDiff.revealFile).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: anchorSnapshot.id,
        readOnly: true,
      }),
    );
    outdatedAdapter.dispose();
  });

  it("removes archived comments from active diffs but shows explicit History diffs read-only", async () => {
    const active = recordWithRanges();
    const harness = makeHarness(active);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const activeRendered = harness.rendered.find(({ disposed }) => !disposed);
    expect(activeRendered).toBeDefined();

    const record: ReviewRecord = {
      ...active,
      review: {
        ...active.review,
        state: "archived",
        archivedAt: active.review.updatedAt,
      },
    };
    harness.record = record;
    harness.lifecycleListener?.();
    await adapter.refresh();
    expect(activeRendered?.disposed).toBe(true);
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(0);

    const historyDocument = harness.addDocument({
      ...identityFor(record),
      readOnly: true,
    });
    await adapter.refresh();
    const historicalRendered = harness.rendered.find(({ disposed }) => !disposed);
    expect(historicalRendered?.uri.toString()).toBe(
      historyDocument.uri.toString(),
    );
    expect(historicalRendered?.canReply).toBe(false);
    expect(historicalRendered?.contextValue).toContain(".readOnly");
    expect(historicalRendered?.comments[0]?.contextValue).toBe(
      "inreview.comment.user.readOnly",
    );

    const provider = adapter.controller.commentingRangeProvider;
    expect(provider).toBeDefined();
    await expect(
      provider?.provideCommentingRanges(historyDocument, {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      }),
    ).resolves.toEqual([]);
    adapter.dispose();
  });

  it("coalesces UI callbacks from creation, mutation, and disposal", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const original = record.threads[0];
    if (original === undefined) {
      throw new Error("Missing fixture thread.");
    }
    const added = copyThread(original);
    harness.record = {
      ...record,
      threads: [original, added],
      review: {
        ...record.review,
        counts: { open: 2, outdated: 0, resolved: 0 },
      },
    };

    harness.onCreate = () => {
      void adapter.refresh();
    };
    let calls = harness.getReview.mock.calls.length;
    await adapter.refresh();
    expect(harness.getReview.mock.calls.length - calls).toBe(2);
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(2);

    harness.onCreate = undefined;
    harness.onMutation = () => {
      void adapter.refresh();
    };
    const changed = {
      ...original,
      state: "resolved" as const,
      resolvedAt: new Date(Date.parse(original.updatedAt) + 1_000).toISOString(),
      updatedAt: new Date(Date.parse(original.updatedAt) + 1_000).toISOString(),
    };
    harness.record = {
      ...harness.record,
      threads: [changed, added],
      review: {
        ...harness.record.review,
        counts: { open: 1, outdated: 0, resolved: 1 },
      },
    };
    calls = harness.getReview.mock.calls.length;
    await adapter.refresh();
    expect(harness.getReview.mock.calls.length - calls).toBe(2);

    harness.onMutation = undefined;
    harness.onDispose = () => {
      void adapter.refresh();
    };
    harness.record = {
      ...harness.record,
      threads: [changed],
      review: {
        ...harness.record.review,
        counts: { open: 0, outdated: 0, resolved: 1 },
      },
    };
    calls = harness.getReview.mock.calls.length;
    await adapter.refresh();
    expect(harness.getReview.mock.calls.length - calls).toBe(2);
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(1);
    adapter.dispose();
  });

  it("coalesces a service event with an explicit refresh without duplicates", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();

    harness.commentListener?.();
    await adapter.refresh();

    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(1);
    expect(harness.rendered).toHaveLength(1);
    adapter.dispose();
  });

  it("awaits a command's event-driven refresh without adding another pass", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const rendered = harness.rendered[0];
    const message = record.threads[0]?.messages[0];
    if (rendered === undefined || message === undefined) {
      throw new Error("Missing fixture thread.");
    }
    harness.commentService.reply.mockImplementationOnce(() => {
      harness.commentListener?.();
      return Promise.resolve(message);
    });
    const calls = harness.getReview.mock.calls.length;

    await adapter.submit({ thread: rendered, text: "Reply" });

    expect(harness.getReview.mock.calls.length - calls).toBe(1);
    expect(harness.rendered).toHaveLength(1);
    expect(rendered.disposed).toBe(false);
    adapter.dispose();
  });

  it("logs one rebuild error and accepts a later refresh", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const logError = vi.fn();
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
      logError,
    });
    await adapter.refresh();
    const persisted = record.threads[0];
    if (persisted === undefined) {
      throw new Error("Missing fixture thread.");
    }
    harness.record = {
      ...record,
      review: {
        ...record.review,
        counts: { open: 0, outdated: 0, resolved: 1 },
      },
      threads: [
        {
          ...persisted,
          state: "resolved",
          resolvedAt: persisted.updatedAt,
        },
      ],
    };
    harness.onMutation = () => {
      throw new Error("Simulated VS Code setter failure.");
    };

    await adapter.refresh();
    expect(logError).toHaveBeenCalledOnce();

    harness.onMutation = undefined;
    await adapter.refresh();
    expect(logError).toHaveBeenCalledOnce();
    expect(harness.rendered[0]?.state).toBe(
      harness.api.CommentThreadState.Resolved,
    );
    adapter.dispose();
  });

  it("reconciles added, changed, moved, and removed persisted threads", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const original = record.threads[0];
    const snapshot = record.snapshots[0];
    const originalMessage = original?.messages[0];
    if (
      original === undefined ||
      originalMessage === undefined ||
      original.projection === null ||
      snapshot === undefined
    ) {
      throw new Error("Missing fixture data.");
    }
    const originalProjection = original.projection;
    const originalRendered = harness.rendered[0];
    const added = copyThread(original);
    harness.record = {
      ...record,
      threads: [original, added],
      review: {
        ...record.review,
        counts: { open: 2, outdated: 0, resolved: 0 },
      },
    };
    await adapter.refresh();
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(2);
    expect(originalRendered?.disposed).toBe(false);

    const changed = {
      ...original,
      messages: [
        {
          ...originalMessage,
          body: "Changed body",
          updatedAt: new Date(
            Date.parse(originalMessage.updatedAt) + 1_000,
          ).toISOString(),
        },
      ],
      updatedAt: new Date(Date.parse(original.updatedAt) + 1_000).toISOString(),
    };
    harness.record = { ...harness.record, threads: [changed, added] };
    const commentsBefore = originalRendered?.comments;
    await adapter.refresh();
    expect(originalRendered?.disposed).toBe(false);
    expect(originalRendered?.comments).not.toBe(commentsBefore);
    expect(originalRendered?.comments[0]?.body).toBe("Changed body");

    const newSnapshotId = randomUUID();
    const newSnapshot = { ...structuredClone(snapshot), id: newSnapshotId };
    const moved = {
      ...changed,
      projection: {
        ...originalProjection,
        snapshotId: newSnapshotId,
      },
    };
    harness.addDocument({
      ...identityFor(record),
      snapshotId: newSnapshotId,
    });
    harness.record = {
      ...harness.record,
      review: {
        ...harness.record.review,
        currentSnapshotId: newSnapshotId,
        snapshotIds: [snapshot.id, newSnapshotId],
      },
      snapshots: [snapshot, newSnapshot],
      threads: [moved],
    };
    await adapter.refresh();
    const movedRendered = harness.rendered.find(
      ({ disposed, uri }) =>
        !disposed && uri.toString() !== harness.document.uri.toString(),
    );
    expect(movedRendered).toBeDefined();
    expect(originalRendered?.disposed).toBe(true);
    expect(movedRendered?.disposed).toBe(false);

    harness.record = {
      ...harness.record,
      review: {
        ...harness.record.review,
        counts: { open: 0, outdated: 0, resolved: 0 },
      },
      threads: [],
    };
    await adapter.refresh();
    expect(movedRendered?.disposed).toBe(true);
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(0);
    adapter.dispose();
  });

  it("updates metadata on reused threads and comments", async () => {
    const record = recordWithRanges();
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const persisted = record.threads[0];
    const rendered = harness.rendered[0];
    const comment = rendered?.comments[0];
    if (persisted === undefined || rendered === undefined || comment === undefined) {
      throw new Error("Missing rendered fixture data.");
    }
    const persistedMessage = persisted.messages[0];
    if (persistedMessage === undefined) {
      throw new Error("Missing persisted message.");
    }
    const nextUpdatedAt = new Date(
      Date.parse(persisted.updatedAt) + 5_000,
    ).toISOString();
    harness.record = {
      ...record,
      threads: [{ ...persisted, updatedAt: nextUpdatedAt }],
    };
    await adapter.refresh();
    expect(harness.rendered).toHaveLength(1);
    expect(rendered.comments[0]).toBe(comment);

    await adapter.submit({ thread: rendered, text: "Reply" });
    await adapter.save(comment);
    await adapter.delete(comment);
    await adapter.resolve(rendered);
    for (const call of [
      harness.commentService.reply,
      harness.commentService.editMessage,
      harness.commentService.deleteMessage,
      harness.commentService.resolve,
    ]) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          commentId: persisted.commentId,
          expectedUpdatedAt: nextUpdatedAt,
        }),
      );
    }
    expect(harness.commentService.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: persistedMessage.id }),
    );
    expect(harness.commentService.deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: persistedMessage.id }),
    );
    adapter.dispose();
  });

  it("stops queued work and disposes resources once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness(recordWithRanges(), gate);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    const queued = adapter.refresh();
    adapter.dispose();
    adapter.dispose();
    release();
    await queued;

    expect(harness.rendered).toHaveLength(0);
    expect(harness.controllerDisposed).toHaveBeenCalledOnce();
    for (const dispose of harness.subscriptionDisposals) {
      expect(dispose).toHaveBeenCalledOnce();
    }
  });
});

function recordWithRanges(): ReviewRecord {
  const record = makeReviewRecord(fingerprint);
  const snapshot = record.snapshots[0];
  const combined = snapshot?.views[0];
  const perChange = snapshot?.views[1];
  const combinedFile = combined?.files[0];
  const perChangeFile = perChange?.files[0];
  if (
    snapshot === undefined ||
    combined === undefined ||
    perChange === undefined ||
    combinedFile === undefined ||
    perChangeFile === undefined
  ) {
    throw new Error("Incomplete review fixture.");
  }
  const second = {
    kind: "context" as const,
    content: "world",
    oldLine: 1,
    newLine: 2,
  };
  const updateFile = (file: typeof combinedFile) => {
    const hunk = file.hunks[0];
    if (hunk === undefined) {
      throw new Error("Missing fixture hunk.");
    }
    return {
      ...file,
      commentableRanges: [{ start: 1, end: 2 }],
      hunks: [{ ...hunk, newLines: 2, lines: [...hunk.lines, second] }],
    };
  };
  return {
    ...record,
    snapshots: [
      {
        ...snapshot,
        views: [
          { ...combined, files: [updateFile(combinedFile)] },
          { ...perChange, files: [updateFile(perChangeFile)] },
        ],
      },
    ],
  };
}

function recordWithOriginalSide(): ReviewRecord {
  const record = recordWithRanges();
  return {
    ...record,
    snapshots: record.snapshots.map((snapshot) => ({
      ...snapshot,
      views: snapshot.views.map((view) => ({
        ...view,
        files: view.files.map((file) => ({
          ...file,
          status: "modified" as const,
          originalPath: "file.txt",
          originalContent: file.modifiedContent,
        })),
      })),
    })),
  };
}

function recordWithAgentAndFileComment(): ReviewRecord {
  const record = recordWithRanges();
  const line = record.threads[0];
  if (line === undefined) {
    throw new Error("Missing fixture thread.");
  }
  const projection = line.projection;
  const message = line.messages[0];
  if (projection === null || message === undefined) {
    throw new Error("The fixture thread is incomplete.");
  }
  const agent = {
    id: randomUUID(),
    author: "agent" as const,
    displayName: "Agent",
    body: "Agent response",
    createdAt: line.updatedAt,
    updatedAt: line.updatedAt,
  };
  const file: PersistedCommentThread = {
    ...structuredClone(line),
    commentId: randomUUID(),
    anchor: {
      ...structuredClone(line.anchor),
      target: { kind: "file" },
      targetText: null,
      storedHunk: null,
    },
    projection: {
      ...projection,
      target: { kind: "file" },
    },
    messages: [{ ...message, id: randomUUID(), body: "Whole file" }],
  };
  return {
    ...record,
    review: {
      ...record.review,
      counts: { open: 2, outdated: 0, resolved: 0 },
    },
    threads: [{ ...line, messages: [...line.messages, agent] }, file],
  };
}

function identityFor(record: ReviewRecord): VirtualDocumentIdentity {
  return {
    reviewId: record.review.id,
    snapshotId: record.review.currentSnapshotId,
    view: { mode: "combined" },
    fileId: "file-a",
    side: "modified",
    repositoryPath: "file.txt",
    readOnly: false,
  };
}

class TestUri {
  public readonly query = "";
  public readonly fragment = "";

  public constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
  ) {}

  public static from(components: {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
  }): vscode.Uri {
    return new TestUri(
      components.scheme,
      components.authority,
      components.path,
    ) as unknown as vscode.Uri;
  }

  public toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

class TestPosition {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

class TestRange {
  public readonly start: TestPosition;
  public readonly end: TestPosition;

  public constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    this.start = new TestPosition(startLine, startCharacter);
    this.end = new TestPosition(endLine, endCharacter);
  }
}

class TestSelection extends TestRange {
  public constructor(start: TestPosition, end: TestPosition) {
    super(start.line, start.character, end.line, end.character);
  }
}

interface RenderedThread {
  uri: vscode.Uri;
  range: vscode.Range;
  comments: readonly vscode.Comment[];
  collapsibleState: vscode.CommentThreadCollapsibleState;
  canReply: boolean;
  state?: vscode.CommentThreadState;
  contextValue?: string;
  label?: string;
  disposed: boolean;
  propertyWrites: number;
  disposeCalls: number;
  dispose(): void;
}

function makeRenderedThread(
  uri: vscode.Uri,
  comments: readonly vscode.Comment[],
  range: TestRange | vscode.Range = new TestRange(0, 0, 0, 5),
  onMutation?: () => void,
  onDispose?: () => void,
): RenderedThread & vscode.CommentThread {
  const thread = {
    uri,
    range: range as unknown as vscode.Range,
    comments,
    collapsibleState: 0,
    canReply: true,
    disposed: false,
    propertyWrites: 0,
    disposeCalls: 0,
    dispose() {
      this.disposeCalls += 1;
      this.disposed = true;
      onDispose?.();
    },
  };
  for (const property of [
    "range",
    "comments",
    "collapsibleState",
    "canReply",
    "state",
    "contextValue",
    "label",
  ] as const) {
    let current: unknown = Reflect.get(thread, property);
    Object.defineProperty(thread, property, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = value;
        thread.propertyWrites += 1;
        onMutation?.();
      },
    });
  }
  return thread;
}

function copyThread(thread: PersistedCommentThread): PersistedCommentThread {
  return {
    ...structuredClone(thread),
    commentId: randomUUID(),
    messages: thread.messages.map((message) => ({
      ...structuredClone(message),
      id: randomUUID(),
    })),
  };
}

function makeHarness(record: ReviewRecord, getReviewGate?: Promise<void>) {
  const codec = new VirtualDocumentUriCodec(key, {
    from: (components) => TestUri.from(components),
  });
  const makeDocument = (identity: VirtualDocumentIdentity) =>
    ({
      uri: codec.encode(identity),
      lineCount: 2,
      lineAt: (line: number) => ({
        range: new TestRange(line, 0, line, 5),
      }),
    }) as unknown as vscode.TextDocument;
  const document = makeDocument(identityFor(record));
  const documents = [document];
  const rendered: RenderedThread[] = [];
  const controllerDisposed = vi.fn();
  const subscriptionDisposals = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  let lifecycleListener: (() => void) | undefined;
  let commentListener: (() => void) | undefined;
  let currentRecord = record;
  let onCreate: (() => void) | undefined;
  let onMutation: (() => void) | undefined;
  let onDispose: (() => void) | undefined;
  const commentService = {
    subscribe: vi.fn((listener: () => void) => {
      commentListener = listener;
      return { dispose: subscriptionDisposals[3] };
    }),
    createThread: vi.fn().mockResolvedValue(record.threads[0]),
    reply: vi.fn().mockResolvedValue(record.threads[0]?.messages[0]),
    editMessage: vi.fn().mockResolvedValue(record.threads[0]?.messages[0]),
    deleteMessage: vi.fn().mockResolvedValue({ threadRemoved: false }),
    resolve: vi.fn().mockResolvedValue(record.threads[0]),
    reopen: vi.fn().mockResolvedValue(record.threads[0]),
  };
  const getReview = vi.fn(async () => {
    await getReviewGate;
    return currentRecord;
  });
  const service = {
    getReview,
    subscribe: vi.fn((listener: () => void) => {
      lifecycleListener = listener;
      return { dispose: subscriptionDisposals[2] };
    }),
    commentService,
  } as unknown as ReviewService;
  const editor = {
    document,
    selection: undefined,
    revealRange: vi.fn(),
  };
  let input: string | undefined;
  const api = {
    comments: {
      createCommentController: vi.fn(() => ({
        id: "inreview",
        label: "InReview",
        createCommentThread: (
          targetUri: vscode.Uri,
          range: vscode.Range,
          comments: readonly vscode.Comment[],
        ) => {
          const thread = makeRenderedThread(
            targetUri,
            comments,
            range,
            () => onMutation?.(),
            () => onDispose?.(),
          );
          rendered.push(thread);
          onCreate?.();
          return thread;
        },
        dispose: controllerDisposed,
      })),
    },
    workspace: {
      textDocuments: documents,
      onDidOpenTextDocument: vi.fn(() => ({
        dispose: subscriptionDisposals[0],
      })),
      onDidCloseTextDocument: vi.fn(() => ({
        dispose: subscriptionDisposals[1],
      })),
    },
    window: {
      visibleTextEditors: [editor],
      activeTextEditor: editor,
      showInputBox: vi.fn(() => Promise.resolve(input)),
    },
    Uri: TestUri,
    Range: TestRange,
    Selection: TestSelection,
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  } as unknown as CommentVscodeApi;
  const nativeDiff = { revealFile: vi.fn().mockResolvedValue(undefined) };
  return {
    api,
    service,
    commentService,
    nativeDiff,
    document,
    editor,
    rendered,
    controllerDisposed,
    subscriptionDisposals,
    getReview,
    get lifecycleListener() {
      return lifecycleListener;
    },
    addDocument(identity: VirtualDocumentIdentity) {
      const added = makeDocument(identity);
      documents.push(added);
      return added;
    },
    get record() {
      return currentRecord;
    },
    set record(value: ReviewRecord) {
      currentRecord = value;
    },
    get onCreate() {
      return onCreate;
    },
    set onCreate(value: (() => void) | undefined) {
      onCreate = value;
    },
    get onMutation() {
      return onMutation;
    },
    set onMutation(value: (() => void) | undefined) {
      onMutation = value;
    },
    get onDispose() {
      return onDispose;
    },
    set onDispose(value: (() => void) | undefined) {
      onDispose = value;
    },
    get commentListener() {
      return commentListener;
    },
    get input() {
      return input;
    },
    set input(value: string | undefined) {
      input = value;
    },
  };
}
