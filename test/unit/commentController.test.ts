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
  it("offers only exact current new-side text hunk ranges", () => {
    const record = recordWithRanges();
    const identity = identityFor(record);

    expect(resolveCommentDocument(record, identity)?.file.fileId).toBe("file-a");
    expect(commentableRanges(record, identity)).toEqual([
      { start: 1, end: 2 },
    ]);
    expect(commentableRanges(record, { ...identity, side: "original" })).toEqual(
      [],
    );
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
      ),
    ).toEqual([]);
    expect(
      commentableRanges(record, {
        ...identity,
        repositoryPath: "other.txt",
      }),
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
});

describe("VS Code comment adapter", () => {
  it("renders persisted authors and file labels, refreshes without duplicates, and disposes", async () => {
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

    harness.commentListener?.();
    await adapter.refresh();
    expect(harness.rendered.filter(({ disposed }) => !disposed)).toHaveLength(2);
    expect(harness.rendered.filter(({ disposed }) => disposed).length).toBeGreaterThan(
      0,
    );

    adapter.dispose();
    adapter.dispose();
    expect(harness.controllerDisposed).toHaveBeenCalledOnce();
    expect(harness.rendered.every(({ disposed }) => disposed)).toBe(true);
  });

  it("persists create, reply, edit, delete, resolve, reopen, and file comments", async () => {
    const record = recordWithRanges();
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

  it("keeps archived threads read-only and returns no commenting ranges", async () => {
    const active = recordWithRanges();
    const record: ReviewRecord = {
      ...active,
      review: {
        ...active.review,
        state: "archived",
        archivedAt: active.review.updatedAt,
      },
    };
    const harness = makeHarness(record);
    const adapter = new InReviewCommentController({
      service: harness.service,
      nativeDiff: harness.nativeDiff,
      signingKey: key,
      vscode: harness.api,
    });
    await adapter.refresh();
    const rendered = harness.rendered.find(({ disposed }) => !disposed);
    expect(rendered?.canReply).toBe(false);
    const provider = adapter.controller.commentingRangeProvider;
    expect(provider).toBeDefined();
    await expect(
      provider?.provideCommentingRanges(harness.document, {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      }),
    ).resolves.toEqual([]);
    adapter.dispose();
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
  dispose(): void;
}

function makeRenderedThread(
  uri: vscode.Uri,
  comments: readonly vscode.Comment[],
  range = new TestRange(0, 0, 0, 5),
): RenderedThread & vscode.CommentThread {
  return {
    uri,
    range: range as unknown as vscode.Range,
    comments,
    collapsibleState: 0,
    canReply: true,
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
}

function makeHarness(record: ReviewRecord) {
  const codec = new VirtualDocumentUriCodec(key, {
    from: (components) => TestUri.from(components),
  });
  const uri = codec.encode(identityFor(record));
  const document = {
    uri,
    lineCount: 2,
    lineAt: (line: number) => ({
      range: new TestRange(line, 0, line, line === 0 ? 5 : 5),
    }),
  } as unknown as vscode.TextDocument;
  const rendered: RenderedThread[] = [];
  const controllerDisposed = vi.fn();
  let lifecycleListener: (() => void) | undefined;
  let commentListener: (() => void) | undefined;
  const commentService = {
    subscribe: vi.fn((listener: () => void) => {
      commentListener = listener;
      return { dispose: vi.fn() };
    }),
    createThread: vi.fn().mockResolvedValue(record.threads[0]),
    reply: vi.fn().mockResolvedValue(record.threads[0]?.messages[0]),
    editMessage: vi.fn().mockResolvedValue(record.threads[0]?.messages[0]),
    deleteMessage: vi.fn().mockResolvedValue({ threadRemoved: false }),
    resolve: vi.fn().mockResolvedValue(record.threads[0]),
    reopen: vi.fn().mockResolvedValue(record.threads[0]),
  };
  const service = {
    getReview: vi.fn().mockResolvedValue(record),
    subscribe: vi.fn((listener: () => void) => {
      lifecycleListener = listener;
      return { dispose: vi.fn() };
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
          const thread = makeRenderedThread(targetUri, comments);
          thread.range = range;
          rendered.push(thread);
          return thread;
        },
        dispose: controllerDisposed,
      })),
    },
    workspace: {
      textDocuments: [document],
      onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      visibleTextEditors: [editor],
      activeTextEditor: editor,
      onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
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
    lifecycleListener,
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
