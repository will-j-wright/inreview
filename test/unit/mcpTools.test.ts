import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewRecord } from "../../src/domain/comments";
import { DomainError } from "../../src/domain/errors";
import type { ReviewReadSession, ReviewRepository } from "../../src/review/types";
import { ReviewService } from "../../src/review/reviewService";
import {
  closeCommentsInputSchema,
  closeCommentsOutputSchema,
  connectWorkspaceInputSchema,
  connectWorkspaceOutputSchema,
  readCommentsInputSchema,
  readCommentsOutputSchema,
  readReviewMetadataOutputSchema,
  replyCommentInputSchema,
  replyCommentOutputSchema,
} from "../../src/mcp/schemas";
import { createMcpToolSessionContext } from "../../src/mcp/toolContext";
import { createMcpReviewToolHandlers } from "../../src/mcp/tools";
import { ReviewStore } from "../../src/storage";
import { makeReviewRecord } from "./storageFixtures";

const workRoot = path.resolve(".test-work", "mcp-tools");
const repositoryRoot = path.resolve(".test-work", "mcp-repository");
const usedDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...usedDirectories].map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  usedDirectories.clear();
});

describe("MCP workspace connection", () => {
  it("normalizes the platform path, rejects wrong and traversal paths, and reports no active review", async () => {
    const harness = await createHarness(false);
    try {
      const context = createMcpToolSessionContext();
      const handlers = createMcpReviewToolHandlers({
        service: harness.service,
        session: context,
      });

      const noActive = connectWorkspaceOutputSchema.parse(
        (
          await handlers.connectWorkspace({
            workspace_root: `${repositoryRoot}${path.sep}`,
          })
        ).structuredContent,
      );
      expect(noActive.status).toBe("no_active_review");
      expect(context.binding).toBeUndefined();

      const differentCase = connectWorkspaceOutputSchema.parse(
        (
          await handlers.connectWorkspace({
            workspace_root: repositoryRoot.toUpperCase(),
          })
        ).structuredContent,
      );
      expect(differentCase.status).toBe(
        process.platform === "win32" ? "no_active_review" : "error",
      );

      const relative = connectWorkspaceOutputSchema.parse(
        (
          await handlers.connectWorkspace({
            workspace_root: "mcp-repository",
          })
        ).structuredContent,
      );
      expect(relative).toMatchObject({
        status: "error",
        error: { code: "WORKSPACE_MISMATCH" },
      });

      const traversal = connectWorkspaceOutputSchema.parse(
        (
          await handlers.connectWorkspace({
            workspace_root: `${repositoryRoot}${path.sep}child${path.sep}..`,
          })
        ).structuredContent,
      );
      expect(traversal).toMatchObject({
        status: "error",
        error: { code: "WORKSPACE_MISMATCH" },
      });

      const wrong = connectWorkspaceOutputSchema.parse(
        (
          await handlers.connectWorkspace({
            workspace_root: path.resolve(".test-work", "other"),
          })
        ).structuredContent,
      );
      expect(wrong).toMatchObject({
        status: "error",
        error: { code: "WORKSPACE_MISMATCH" },
      });
    } finally {
      await harness.close();
    }
  });

  it("isolates bindings by session and rejects every review tool before connect", async () => {
    const harness = await createHarness();
    try {
      const first = createMcpToolSessionContext();
      const second = createMcpToolSessionContext();
      const firstHandlers = createMcpReviewToolHandlers({
        service: harness.service,
        session: first,
      });
      const secondHandlers = createMcpReviewToolHandlers({
        service: harness.service,
        session: second,
      });
      await firstHandlers.connectWorkspace({ workspace_root: repositoryRoot });
      expect(first.binding).toBeDefined();
      expect(second.binding).toBeUndefined();

      const results = await Promise.all([
        secondHandlers.readReviewMetadata({}),
        secondHandlers.readComments({}),
        secondHandlers.replyComment({
          comment_id: harness.record.review.id,
          body: "Reply",
        }),
        secondHandlers.closeComments({
          comments: [{ comment_id: harness.record.review.id }],
        }),
      ]);
      for (const result of results) {
        expect(result.structuredContent).toMatchObject({
          status: "error",
          error: { code: "NOT_CONNECTED" },
        });
      }
    } finally {
      await harness.close();
    }
  });
});

describe("MCP review reads and mutations", () => {
  it("returns metadata without blobs, file contents, or hunks", async () => {
    const harness = await createHarness();
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      const output = readReviewMetadataOutputSchema.parse(
        (await handlers.readReviewMetadata({})).structuredContent,
      );
      expect(output.status).toBe("success");
      if (output.status !== "success") {
        return;
      }
      expect(output.review).toMatchObject({
        reviewId: harness.record.review.id,
        requestedChangeCount: 1,
        actualChangeCount: 1,
      });
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain("modifiedContent");
      expect(serialized).not.toContain('"hunks"');
      expect(serialized).not.toContain('"sha256"');
      expect(output.currentSnapshot.views[0]?.files[0]).toMatchObject({
        currentPath: "file.txt",
        addedLines: 1,
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps large added-file output small for multiple threads without changing stored anchors", async () => {
    const lineCount = 10_000;
    const lines = Array.from(
      { length: lineCount },
      (_, index) => `stored line ${String(index + 1).padStart(5, "0")}`,
    );
    const hunk = {
      header: `@@ -0,0 +1,${String(lineCount)} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lineCount,
      lines: lines.map((content, index) => ({
        kind: "addition" as const,
        content,
        oldLine: null,
        newLine: index + 1,
      })),
      raw: lines.map((line) => `+${line}\n`).join(""),
    };
    const harness = await createHarness(true, (record) => ({
      ...record,
      review: { ...record.review, counts: { open: 0, outdated: 0, resolved: 0 } },
      threads: [],
      snapshots: record.snapshots.map((snapshot) => ({
        ...snapshot,
        views: snapshot.views.map((view) => ({
          ...view,
          changedLineCount: lineCount,
          files: view.files.map((file) => ({
            ...file,
            hunks: [hunk],
            addedLines: lineCount,
          })),
        })),
      })),
    }));
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      expect((await readComments(handlers, {})).comments).toEqual([]);
      const targetLines = [1, 5_000, lineCount];
      for (const line of targetLines) {
        await harness.service.commentService.createThread({
          reviewId: harness.record.review.id,
          snapshotId: harness.record.review.currentSnapshotId,
          view: { mode: "combined" },
          fileId: "file-a",
          target: { kind: "line", line },
          body: `Review line ${String(line)}`,
          displayName: "Reviewer",
        });
      }
      const before = await harness.store.getReview(harness.record.review.id);
      const result = await handlers.readComments({});
      const output = readCommentsOutputSchema.parse(result.structuredContent);
      expect(output.status).toBe("success");
      if (output.status !== "success") {
        throw new Error(output.error.message);
      }
      expect(output.comments).toHaveLength(3);
      for (const comment of output.comments) {
        const line = comment.anchor.line;
        if (line === null) {
          throw new Error("The regression fixture requires a line comment.");
        }
        const start = Math.max(0, line - 1 - 5);
        expect(comment.anchor.context).toEqual({
          targetIndex: line - 1 - start,
          lines: lines.slice(start, Math.min(lineCount, line + 5)),
        });
        expect(comment.anchor.context?.lines.length).toBeLessThanOrEqual(11);
        expect(comment.anchor.targetLine).toBe(lines[line - 1]);
      }
      // Measure both MCP representations, not just the schema-parsed object.
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16_000);
      const previousOutput = {
        ...output,
        comments: output.comments.map((comment) => {
          const stored = before.threads.find(
            ({ commentId }) => commentId === comment.commentId,
          );
          if (stored === undefined) {
            throw new Error("The returned thread must exist in storage.");
          }
          const anchor = { ...comment.anchor };
          Reflect.deleteProperty(anchor, "context");
          return {
            ...comment,
            anchor: {
              ...anchor,
              storedHunk: stored.anchor.storedHunk,
              fullFileContext: null,
            },
          };
        }),
      };
      const previousResult = {
        content: [{ type: "text", text: JSON.stringify(previousOutput) }],
        structuredContent: previousOutput,
      };
      const previousBytes = Buffer.byteLength(JSON.stringify(previousResult));
      const currentBytes = Buffer.byteLength(JSON.stringify(result));
      expect(previousBytes).toBeGreaterThan(currentBytes * 100);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("storedHunk");
      expect(serialized).not.toContain('"raw"');
      expect(serialized).not.toContain("stored line 02500");
      expect(serialized).not.toContain("stored line 07500");
      expect(await harness.store.getReview(harness.record.review.id)).toEqual(before);
      expect(before.threads.every(
        ({ anchor }) => anchor.storedHunk?.lines.length === lineCount,
      )).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("reports invalid stored hunk targets instead of returning incomplete context", async () => {
    const harness = await createHarness(true, (record) => {
      const thread = record.threads[0];
      if (thread === undefined) {
        throw new Error("The fixture requires a thread.");
      }
      thread.anchor.target = { kind: "line", line: 999 };
      return record;
    });
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      const result = await handlers.readComments({});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "error",
        error: { code: "INVALID_DATA" },
      });
      expect(result.structuredContent).not.toHaveProperty("comments");
    } finally {
      await harness.close();
    }
  });

  it("returns only new-side hunk context and excludes deleted lines", async () => {
    const harness = await createHarness(true, (record) => {
      const thread = record.threads[0];
      if (thread?.anchor.storedHunk == null) {
        throw new Error("The fixture requires a stored hunk.");
      }
      thread.anchor.storedHunk.lines.unshift({
        kind: "deletion",
        content: "old content must not be returned",
        oldLine: 1,
        newLine: null,
      });
      thread.anchor.storedHunk.oldStart = 1;
      thread.anchor.storedHunk.oldLines = 1;
      return record;
    });
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      const output = await readComments(handlers, {});
      expect(output.comments[0]?.anchor.context).toEqual({
        targetIndex: 0,
        lines: ["hello"],
      });
      expect(JSON.stringify(output)).not.toContain("old content must not be returned");
    } finally {
      await harness.close();
    }
  });

  it.each([
    { side: "old" as const, outdated: false },
    { side: "new" as const, outdated: false },
    { side: "old" as const, outdated: true },
    { side: "new" as const, outdated: true },
  ])("preserves exact full-file context for $side-side threads (outdated=$outdated)", async ({ side, outdated }) => {
    const lines = Array.from({ length: 11 }, (_, index) => `${side} context ${String(index)}`);
    const harness = await createHarness(true, (record) => {
      const thread = record.threads[0];
      if (thread === undefined) {
        throw new Error("The fixture requires a thread.");
      }
      thread.anchor = {
        ...thread.anchor,
        side,
        originalPath: "old-file.txt",
        target: { kind: "line", line: 100 },
        targetText: lines[5] ?? null,
        storedHunk: null,
        fullFileContext: { targetIndex: 5, lines, fileFingerprint: "a".repeat(64) },
      };
      if (outdated) {
        thread.currentness = "outdated";
        thread.projection = null;
        record.review.counts = { open: 0, outdated: 1, resolved: 0 };
      } else if (thread.projection !== null) {
        thread.projection.side = side;
        thread.projection.target = { kind: "line", line: 105 };
        thread.projection.path = side === "old" ? "old-file.txt" : "file.txt";
      }
      return record;
    });
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      const output = await readComments(handlers, {});
      expect(output.comments[0]).toMatchObject({
        outdated,
        anchor: {
          side,
          line: 100,
          targetLine: lines[5],
          context: { targetIndex: 5, lines },
        },
      });
      expect(output.comments[0]?.currentLocation).toEqual(
        outdated ? null : expect.objectContaining({ side, line: 105 }),
      );
      expect(JSON.stringify(output)).not.toContain("fileFingerprint");
      expect(JSON.stringify(output)).not.toContain("fullFileContext");
    } finally {
      await harness.close();
    }
  });

  it("returns no line context for file comments", async () => {
    const harness = await createHarness();
    try {
      const thread = await harness.service.commentService.createThread({
        reviewId: harness.record.review.id,
        snapshotId: harness.record.review.currentSnapshotId,
        view: { mode: "combined" },
        fileId: "file-a",
        target: { kind: "file" },
        body: "Review the file.",
        displayName: "Reviewer",
      });
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      const output = await readComments(handlers, { comment_ids: [thread.commentId] });
      expect(output.comments).toHaveLength(1);
      expect(output.comments[0]?.anchor).toMatchObject({
        line: null,
        side: null,
        targetLine: null,
        context: null,
      });
    } finally {
      await harness.close();
    }
  });

  it("applies all comment filters and provides stable pagination with bounded context", async () => {
    const harness = await createHarness(true, makeThreadSet);
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });

      const defaults = await readComments(handlers, {});
      expect(defaults.comments.map(({ commentId }) => commentId)).toHaveLength(3);
      expect(defaults.comments.every(({ state }) => state === "open")).toBe(true);
      expect(defaults.comments[0]?.anchor.context).toEqual({
        targetIndex: 0,
        lines: ["hello"],
      });
      expect(defaults.comments[0]?.anchor.side).toBe("new");
      expect(defaults.comments[0]?.currentLocation?.side).toBe("new");

      expect((await readComments(handlers, { status: "open" })).comments).toHaveLength(3);
      expect((await readComments(handlers, { status: "all" })).comments).toHaveLength(4);
      expect((await readComments(handlers, { status: "resolved" })).comments).toHaveLength(1);
      expect((await readComments(handlers, { outdated: true })).comments).toHaveLength(1);
      expect((await readComments(handlers, { outdated: false })).comments).toHaveLength(2);
      expect(
        (await readComments(handlers, { file: "other.txt" })).comments,
      ).toHaveLength(1);
      const selectedId = harness.record.threads[1]?.commentId;
      expect(selectedId).toBeDefined();
      if (selectedId === undefined) {
        return;
      }
      expect(
        (await readComments(handlers, { comment_ids: [selectedId] })).comments,
      ).toHaveLength(1);

      const firstPage = await readComments(handlers, { status: "all", limit: 2 });
      expect(firstPage.comments).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await readComments(handlers, {
        status: "all",
        limit: 2,
        ...(firstPage.nextCursor === null
          ? {}
          : { cursor: firstPage.nextCursor }),
      });
      expect(secondPage.comments).toHaveLength(2);
      expect(
        new Set([
          ...firstPage.comments.map(({ commentId }) => commentId),
          ...secondPage.comments.map(({ commentId }) => commentId),
        ]).size,
      ).toBe(4);
    } finally {
      await harness.close();
    }
  });

  it("replies as Agent and atomically rejects an invalid close batch", async () => {
    const harness = await createHarness();
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      const commentId = harness.record.threads[0]?.commentId;
      expect(commentId).toBeDefined();
      if (commentId === undefined) {
        return;
      }

      const reply = replyCommentOutputSchema.parse(
        (
          await handlers.replyComment({
            comment_id: commentId,
            body: "Agent reply",
          })
        ).structuredContent,
      );
      expect(reply).toMatchObject({
        status: "success",
        message: { author: "Agent", displayName: "Agent" },
      });

      const failed = closeCommentsOutputSchema.parse(
        (
          await handlers.closeComments({
            comments: [
              { comment_id: commentId, resolution_note: "Done" },
              { comment_id: randomUUID() },
            ],
          })
        ).structuredContent,
      );
      expect(failed).toMatchObject({
        status: "error",
        error: { code: "COMMENT_NOT_FOUND" },
      });
      expect(
        (await harness.service.commentService.queryReviewThreads(
          harness.record.review.id,
          { ids: [commentId] },
        )).items[0]?.state,
      ).toBe("open");

      const closed = closeCommentsOutputSchema.parse(
        (
          await handlers.closeComments({
            comments: [{ comment_id: commentId, resolution_note: "Done" }],
          })
        ).structuredContent,
      );
      expect(closed).toMatchObject({
        status: "success",
        resolved: [{ commentId, state: "resolved" }],
      });
    } finally {
      await harness.close();
    }
  });

  it("requires reconnect after the active review is archived", async () => {
    const harness = await createHarness();
    try {
      const handlers = connectedHandlers(harness);
      await handlers.connectWorkspace({ workspace_root: repositoryRoot });
      await harness.service.archiveActiveReview();
      const stale = readCommentsOutputSchema.parse(
        (await handlers.readComments({})).structuredContent,
      );
      expect(stale).toMatchObject({
        status: "error",
        error: { code: "STALE_CONNECTION", reconnectRequired: true },
      });
    } finally {
      await harness.close();
    }
  });

  it("maps domain failures without exposing details", async () => {
    const harness = await createHarness();
    try {
      vi.spyOn(harness.service, "getActiveReviewOrUndefined").mockRejectedValueOnce(
        new DomainError("INVARIANT_VIOLATION", "secret local path"),
      );
      const handlers = connectedHandlers(harness);
      const output = connectWorkspaceOutputSchema.parse(
        (
          await handlers.connectWorkspace({
            workspace_root: repositoryRoot,
          })
        ).structuredContent,
      );
      expect(output).toMatchObject({
        status: "error",
        error: {
          code: "INVALID_DATA",
          message: "Stored review data failed validation.",
        },
      });
      expect(JSON.stringify(output)).not.toContain("secret local path");
    } finally {
      await harness.close();
    }
  });
});

describe("MCP schemas", () => {
  it("rejects malformed and oversized inputs and validates all output families", () => {
    expect(connectWorkspaceInputSchema.safeParse({ workspace_root: 1 }).success).toBe(false);
    expect(readCommentsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      readCommentsInputSchema.safeParse({
        comment_ids: Array.from({ length: 101 }, () => randomUUID()),
      }).success,
    ).toBe(false);
    expect(
      readCommentsInputSchema.safeParse({ file: "../secret" }).success,
    ).toBe(false);
    expect(
      replyCommentInputSchema.safeParse({
        comment_id: randomUUID(),
        body: "x".repeat(65_537),
      }).success,
    ).toBe(false);
    const duplicate = randomUUID();
    expect(
      closeCommentsInputSchema.safeParse({
        comments: [
          { comment_id: duplicate },
          { comment_id: duplicate },
        ],
      }).success,
    ).toBe(false);

    const error = {
      status: "error",
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed.",
        reconnectRequired: false,
      },
    };
    for (const schema of [
      connectWorkspaceOutputSchema,
      readReviewMetadataOutputSchema,
      readCommentsOutputSchema,
      replyCommentOutputSchema,
      closeCommentsOutputSchema,
    ]) {
      expect(schema.safeParse(error).success).toBe(true);
      expect(schema.safeParse({ status: "success" }).success).toBe(false);
    }
  });
});

interface Harness {
  readonly store: ReviewStore;
  readonly service: ReviewService;
  readonly record: ReviewRecord;
  close(): Promise<void>;
}

async function createHarness(
  withRecord = true,
  transform: (record: ReviewRecord) => ReviewRecord = (record) => record,
): Promise<Harness> {
  const storageRoot = path.join(workRoot, randomUUID());
  usedDirectories.add(storageRoot);
  await mkdir(storageRoot, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  const store = await ReviewStore.open({
    storageRoot,
    canonicalRepositoryRoot: repositoryRoot,
    environment: "test",
  });
  const record = transform(makeReviewRecord(store.fingerprint));
  if (withRecord) {
    await store.putReview(record);
  }
  const service = new ReviewService({
    canonicalRepositoryRoot: repositoryRoot,
    environment: "test",
    store,
    repository: new UnusedRepository(),
  });
  return {
    store,
    service,
    record,
    close: async () => store.close(),
  };
}

class UnusedRepository implements ReviewRepository {
  public readonly repository = repositoryRoot;

  public getCurrentOperationId(): Promise<string> {
    return Promise.reject(new Error("The MCP tool test does not capture snapshots."));
  }

  public async openReadSession(): Promise<ReviewReadSession> {
    return Promise.reject(new Error("The MCP tool test does not capture snapshots."));
  }
}

function connectedHandlers(harness: Harness) {
  return createMcpReviewToolHandlers({
    service: harness.service,
    session: createMcpToolSessionContext(),
  });
}

async function readComments(
  handlers: ReturnType<typeof connectedHandlers>,
  input: Parameters<typeof handlers.readComments>[0],
) {
  const output = readCommentsOutputSchema.parse(
    (await handlers.readComments(input)).structuredContent,
  );
  expect(output.status).toBe("success");
  if (output.status !== "success") {
    throw new Error(output.error.message);
  }
  return output;
}

function makeThreadSet(record: ReviewRecord): ReviewRecord {
  const template = record.threads[0];
  if (template === undefined) {
    return record;
  }
  const makeThread = (
    index: number,
    options: {
      readonly outdated?: boolean;
      readonly resolved?: boolean;
      readonly path?: string;
    } = {},
  ) => ({
    ...structuredClone(template),
    commentId: randomUUID(),
    createdAt: `2026-01-0${String(index)}T00:00:00.000Z`,
    updatedAt: `2026-01-0${String(index)}T00:00:00.000Z`,
    state: options.resolved === true ? ("resolved" as const) : ("open" as const),
    currentness:
      options.outdated === true ? ("outdated" as const) : ("current" as const),
    resolvedAt:
      options.resolved === true
        ? `2026-01-0${String(index)}T00:00:00.000Z`
        : null,
    anchor: {
      ...structuredClone(template.anchor),
      currentPath: options.path ?? template.anchor.currentPath,
    },
    projection:
      options.outdated === true
        ? null
        : template.projection === null
          ? null
          : {
              ...structuredClone(template.projection),
              path: options.path ?? template.projection.path,
            },
    messages: template.messages.map((message) => ({
      ...structuredClone(message),
      id: randomUUID(),
    })),
  });
  const threads = [
    makeThread(1),
    makeThread(2, { outdated: true }),
    makeThread(3, { path: "other.txt" }),
    makeThread(4, { resolved: true }),
  ];
  return {
    ...record,
    review: {
      ...record.review,
      counts: { open: 2, outdated: 1, resolved: 1 },
    },
    threads,
  };
}
