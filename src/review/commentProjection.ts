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
import { decodeTextForDisplay } from "../diff/fileKinds";
import type { CommentProjectionContext } from "./types";

export async function projectCommentThreads(
  context: CommentProjectionContext,
): Promise<readonly CommentThread[]> {
  return Promise.all(
    context.previous.threads.map((thread) =>
      projectThread(thread, context.nextSnapshot, context.readBlob),
    ),
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

export function splitTextDocumentLines(content: string): readonly string[] {
  return content.split(/\r\n|\n|\r/u);
}

export function fileTextFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function fullFileContextFingerprint(
  targetIndex: number,
  lines: readonly string[],
): string {
  return hash({ version: 1, targetIndex, lines });
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

async function projectThread(
  thread: CommentThread,
  snapshot: Snapshot,
  readBlob: CommentProjectionContext["readBlob"],
): Promise<CommentThread> {
  const projection = await findProjection(thread, snapshot, readBlob);
  return {
    ...thread,
    projection,
    currentness: projection === null ? "outdated" : "current",
    updatedAt: snapshot.capturedAt,
  };
}

async function findProjection(
  thread: CommentThread,
  snapshot: Snapshot,
  readBlob: CommentProjectionContext["readBlob"],
): Promise<CommentProjection | null> {
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
  const side = thread.anchor.side ?? "new";
  const path =
    thread.anchor.target.kind === "line" && side === "old"
      ? file.originalPath
      : file.currentPath ?? file.originalPath;
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

  const line =
    thread.anchor.fullFileContext == null
      ? findExactHunkLine(thread.anchor, file)
      : await findExactFullFileLine(thread.anchor, file, readBlob);
  if (line === null) {
    return null;
  }
  return {
    snapshotId: snapshot.id,
    view: copyView(view.identity),
    path,
    target: { kind: "line", line },
    side,
  };
}

function findExactHunkLine(
  anchor: CommentAnchor,
  file: FileManifestEntry,
): number | null {
  const side = anchor.side ?? "new";
  if (
    file.kind !== "text" ||
    (side === "old" ? file.originalPath : file.currentPath) === null ||
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
        (side === "old" ? line.oldLine : line.newLine) === targetLine &&
        (side === "old"
          ? line.kind === "deletion" || line.kind === "context"
          : line.kind === "addition" || line.kind === "context") &&
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
      (side === "old"
        ? target.kind === "deletion" || target.kind === "context"
        : target.kind === "addition" || target.kind === "context") &&
      target.content === anchor.targetText &&
      (side === "old" ? target.oldLine : target.newLine) !== null
      ? [side === "old" ? target.oldLine : target.newLine]
      : [];
  });
  const [onlyMatch] = matches;
  return matches.length === 1 && onlyMatch !== undefined ? onlyMatch : null;
}

async function findExactFullFileLine(
  anchor: CommentAnchor,
  file: FileManifestEntry,
  readBlob: CommentProjectionContext["readBlob"],
): Promise<number | null> {
  const context = anchor.fullFileContext;
  if (
    context == null ||
    anchor.storedHunk !== null ||
    anchor.target.kind !== "line" ||
    anchor.targetText === null ||
    file.kind !== "text" ||
    (anchor.side === "old" ? file.originalPath : file.currentPath) === null ||
    (anchor.side === "old" ? file.originalContent : file.modifiedContent) === null
  ) {
    return null;
  }
  const reference =
    anchor.side === "old" ? file.originalContent : file.modifiedContent;
  if (reference === null) {
    return null;
  }
  const content = decodeTextForDisplay(await readBlob(reference));
  const fingerprint = fileTextFingerprint(content);
  const lines = splitTextDocumentLines(content);
  if (
    fullFileContextFingerprint(context.targetIndex, context.lines) !==
      anchor.contextFingerprint ||
    context.lines[context.targetIndex] !== anchor.targetText
  ) {
    return null;
  }
  if (
    fingerprint === context.fileFingerprint &&
    lines[anchor.target.line - 1] === anchor.targetText
  ) {
    return anchor.target.line;
  }
  const matches: number[] = [];
  const lastStart = lines.length - context.lines.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (
      context.lines.every(
        (line, index) => line === lines[start + index],
      )
    ) {
      matches.push(start + context.targetIndex + 1);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
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
