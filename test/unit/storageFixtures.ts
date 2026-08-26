import { createHash, randomUUID } from "node:crypto";

import type { ReviewRecord } from "../../src/domain/comments";
import type { BlobReference, ReviewState } from "../../src/domain/review";

export function makeReviewRecord(
  repositoryFingerprint: string,
  options: {
    readonly id?: string;
    readonly name?: string;
    readonly state?: ReviewState;
    readonly timestamp?: string;
    readonly content?: BlobReference | null;
  } = {},
): ReviewRecord {
  const reviewId = options.id ?? randomUUID();
  const snapshotId = randomUUID();
  const timestamp = options.timestamp ?? "2026-01-01T00:00:00.000Z";
  const state = options.state ?? "active";
  const messageId = randomUUID();
  const commentId = randomUUID();
  const content = options.content ?? {
    sha256: "0".repeat(64),
    byteLength: 0,
    encoding: "gzip" as const,
  };

  return {
    review: {
      id: reviewId,
      name: options.name ?? "Review",
      state,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: state === "archived" ? timestamp : null,
      repositoryFingerprint,
      requestedChangeCount: 1,
      orderedChangeIds: ["change-a"],
      currentSnapshotId: snapshotId,
      snapshotIds: [snapshotId],
      counts: { open: 1, outdated: 0, resolved: 0 },
    },
    snapshots: [
      {
        id: snapshotId,
        capturedAt: timestamp,
        operationId: "operation-a",
        orderedChangeIds: ["change-a"],
        changes: [
          {
            changeId: "change-a",
            commitId: "commit-a",
            parentCommitId: "parent-a",
            description: "Test change",
          },
        ],
        baseCommitId: "parent-a",
        headCommitId: "commit-a",
        views: [
          {
            identity: { mode: "combined" },
            baseCommitId: "parent-a",
            headCommitId: "commit-a",
            changedLineCount: 1,
            files: [
              {
                fileId: "file-a",
                status: "added",
                kind: "text",
                originalPath: null,
                currentPath: "file.txt",
                originalContent: null,
                modifiedContent: content,
                patch: null,
                hunks: [
                  {
                    header: "@@ -0,0 +1 @@",
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 1,
                    lines: [
                      {
                        kind: "addition",
                        content: "hello",
                        oldLine: null,
                        newLine: 1,
                      },
                    ],
                  },
                ],
                addedLines: 1,
                deletedLines: 0,
              },
            ],
          },
          {
            identity: { mode: "per-change", changeId: "change-a" },
            baseCommitId: "parent-a",
            headCommitId: "commit-a",
            changedLineCount: 1,
            files: [
              {
                fileId: "file-a",
                status: "added",
                kind: "text",
                originalPath: null,
                currentPath: "file.txt",
                originalContent: null,
                modifiedContent: content,
                patch: null,
                hunks: [
                  {
                    header: "@@ -0,0 +1 @@",
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 1,
                    lines: [
                      {
                        kind: "addition",
                        content: "hello",
                        oldLine: null,
                        newLine: 1,
                      },
                    ],
                  },
                ],
                addedLines: 1,
                deletedLines: 0,
              },
            ],
          },
        ],
      },
    ],
    threads: [
      {
        commentId,
        reviewId,
        anchor: {
          snapshotId,
          view: { mode: "combined" },
          target: { kind: "line", line: 1 },
          originalPath: null,
          currentPath: "file.txt",
          fileStatus: "added",
          targetText: "hello",
          storedHunk: {
            header: "@@ -0,0 +1 @@",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [
              {
                kind: "addition",
                content: "hello",
                oldLine: null,
                newLine: 1,
              },
            ],
          },
          contextFingerprint: createHash("sha256").update("hello").digest("hex"),
        },
        projection: {
          snapshotId,
          view: { mode: "combined" },
          path: "file.txt",
          target: { kind: "line", line: 1 },
        },
        state: "open",
        currentness: "current",
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        messages: [
          {
            id: messageId,
            author: "user",
            displayName: "Reviewer",
            body: "Please check this.",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
    ],
  };
}
