import { createHash } from "node:crypto";

import type {
  CommentAnchor,
  CommentProjection,
  CommentThread,
} from "../domain/comments";
import type {
  FileManifestEntry,
  PatchHunk,
  PatchLine,
  Snapshot,
  ViewIdentity,
} from "../domain/review";
import { viewIdentityKey } from "../domain/review";
import type { CommentProjectionContext } from "./types";

export function projectCommentThreads(
  context: CommentProjectionContext,
): readonly CommentThread[] {
  return context.previous.threads.map((thread) =>
    projectThread(thread, context.nextSnapshot),
  );
}

export function lineContextFingerprint(
  hunk: PatchHunk,
  targetIndex: number,
): string {
  return hash({
    version: 1,
    targetIndex,
    lines: hunk.lines.map(({ kind, content, noNewlineAtEnd }) => ({
      kind,
      content,
      noNewlineAtEnd: noNewlineAtEnd === true,
    })),
  });
}

export function fileContextFingerprint(
  reviewId: string,
  snapshotId: string,
  view: ViewIdentity,
  file: Pick<
    FileManifestEntry,
    "fileId" | "status" | "kind" | "originalPath" | "currentPath"
  >,
): string {
  return hash({
    version: 1,
    reviewId,
    snapshotId,
    view,
    file,
  });
}

function projectThread(
  thread: CommentThread,
  snapshot: Snapshot,
): CommentThread {
  const projection = findProjection(thread, snapshot);
  return {
    ...thread,
    projection,
    currentness: projection === null ? "outdated" : "current",
    updatedAt: snapshot.capturedAt,
  };
}

function findProjection(
  thread: CommentThread,
  snapshot: Snapshot,
): CommentProjection | null {
  const view = snapshot.views.find(
    ({ identity }) =>
      viewIdentityKey(identity) === viewIdentityKey(thread.anchor.view),
  );
  if (view === undefined) {
    return null;
  }

  const paths = anchorPaths(thread);
  const files = view.files.filter((file) => fileMatchesPaths(file, paths));
  if (files.length !== 1) {
    return null;
  }
  const file = files[0];
  if (file === undefined) {
    return null;
  }
  const path = file.currentPath ?? file.originalPath;
  if (path === null) {
    return null;
  }

  if (thread.anchor.target.kind === "file") {
    return {
      snapshotId: snapshot.id,
      view: copyView(view.identity),
      path,
      target: { kind: "file" },
    };
  }

  const line = findExactLine(thread.anchor, file);
  if (line === null) {
    return null;
  }
  return {
    snapshotId: snapshot.id,
    view: copyView(view.identity),
    path,
    target: { kind: "line", line },
  };
}

function findExactLine(
  anchor: CommentAnchor,
  file: FileManifestEntry,
): number | null {
  if (
    file.kind !== "text" ||
    file.currentPath === null ||
    anchor.storedHunk === null ||
    anchor.targetText === null ||
    anchor.target.kind !== "line"
  ) {
    return null;
  }
  const targetLine = anchor.target.line;
  const storedHunk = anchor.storedHunk;
  const targetIndexes = storedHunk.lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        line.kind !== "deletion" &&
        line.newLine === targetLine &&
        line.content === anchor.targetText,
    );
  if (targetIndexes.length !== 1) {
    return null;
  }
  const targetIndex = targetIndexes[0]?.index;
  if (
    targetIndex === undefined ||
    lineContextFingerprint(storedHunk, targetIndex) !==
      anchor.contextFingerprint
  ) {
    return null;
  }

  const matches = file.hunks.flatMap((hunk) => {
    if (!sameHunkContent(storedHunk, hunk)) {
      return [];
    }
    const target = hunk.lines[targetIndex];
    return target !== undefined &&
      target.kind !== "deletion" &&
      target.content === anchor.targetText &&
      target.newLine !== null
      ? [target.newLine]
      : [];
  });
  const [onlyMatch] = matches;
  return matches.length === 1 && onlyMatch !== undefined ? onlyMatch : null;
}

function sameHunkContent(left: PatchHunk, right: PatchHunk): boolean {
  return (
    left.lines.length === right.lines.length &&
    left.lines.every((line, index) => sameLineContent(line, right.lines[index]))
  );
}

function sameLineContent(left: PatchLine, right: PatchLine | undefined): boolean {
  return (
    left.kind === right?.kind &&
    left.content === right.content &&
    (left.noNewlineAtEnd === true) === (right.noNewlineAtEnd === true)
  );
}

function anchorPaths(thread: CommentThread): ReadonlySet<string> {
  return new Set(
    [
      thread.projection?.path,
      thread.anchor.originalPath,
      thread.anchor.currentPath,
    ].filter((value): value is string => value !== undefined && value !== null),
  );
}

function fileMatchesPaths(
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

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}
