import type { ReviewRecord } from "../domain/comments";
import type {
  BlobReference,
  FileManifestEntry,
  Snapshot,
  ViewIdentity,
  ViewManifest,
} from "../domain/review";
import { viewIdentityKey } from "../domain/review";
import { decodeTextForDisplay } from "../diff/fileKinds";
import type { RevealFileRequest } from "./activeReviewTree";
import type {
  VirtualDocumentIdentity,
  VirtualDocumentSource,
} from "./virtualDocumentProvider";

export interface NativeDiffReviewQuery {
  getReview(reviewId: string): Promise<ReviewRecord>;
}

export interface NativeDiffBlobReader {
  get(reference: BlobReference): Promise<Buffer>;
}

export interface ResolvedNativeDiff {
  readonly record: ReviewRecord;
  readonly snapshot: Snapshot;
  readonly view: ViewManifest;
  readonly file: FileManifestEntry;
  readonly original: VirtualDocumentIdentity;
  readonly modified: VirtualDocumentIdentity;
  readonly title: string;
}

export type NativeDiffErrorCode =
  | "invalid-request"
  | "snapshot-not-found"
  | "view-not-found"
  | "file-not-found"
  | "uri-target-mismatch";

export class NativeDiffError extends Error {
  public constructor(
    public readonly code: NativeDiffErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeDiffError";
  }
}

export class NativeDiffContent implements VirtualDocumentSource {
  public constructor(
    private readonly reviews: NativeDiffReviewQuery,
    private readonly blobs: NativeDiffBlobReader,
  ) {}

  public async resolve(requestValue: unknown): Promise<ResolvedNativeDiff> {
    const request = parseRevealFileRequest(requestValue);
    const record = await this.reviews.getReview(request.reviewId);
    const snapshot = record.snapshots.find(({ id }) => id === request.snapshotId);
    if (snapshot === undefined) {
      throw new NativeDiffError(
        "snapshot-not-found",
        "The selected review snapshot no longer exists.",
      );
    }
    const view = snapshot.views.find(({ identity }) =>
      sameView(identity, request.view),
    );
    if (view === undefined) {
      throw new NativeDiffError(
        "view-not-found",
        "The selected combined or per-change view does not exist in this snapshot.",
      );
    }
    const file = view.files.find(({ fileId }) => fileId === request.fileId);
    if (file === undefined) {
      throw new NativeDiffError(
        "file-not-found",
        "The selected file does not exist in this snapshot view.",
      );
    }
    const originalPath = file.originalPath ?? file.currentPath;
    const modifiedPath = file.currentPath ?? file.originalPath;
    if (originalPath === null || modifiedPath === null) {
      throw new NativeDiffError(
        "file-not-found",
        "The selected file has no repository path.",
      );
    }
    return {
      record,
      snapshot,
      view,
      file,
      original: identityFor(request, originalPath, "original"),
      modified: identityFor(request, modifiedPath, "modified"),
      title: diffTitle(record, snapshot, view, file),
    };
  }

  public async readDocument(identity: VirtualDocumentIdentity): Promise<string> {
    const resolved = await this.resolve({
      reviewId: identity.reviewId,
      snapshotId: identity.snapshotId,
      view: identity.view,
      fileId: identity.fileId,
      readOnly: identity.readOnly,
    });
    const expected =
      identity.side === "original" ? resolved.original : resolved.modified;
    if (expected.repositoryPath !== identity.repositoryPath) {
      throw new NativeDiffError(
        "uri-target-mismatch",
        "The InReview document URI does not match the stored file path.",
      );
    }
    if (resolved.file.kind !== "text") {
      return summarizeNonTextFile(resolved.file);
    }
    const reference =
      identity.side === "original"
        ? resolved.file.originalContent
        : resolved.file.modifiedContent;
    if (reference === null) {
      return "";
    }
    return decodeTextForDisplay(await this.blobs.get(reference));
  }
}

export function summarizeNonTextFile(file: FileManifestEntry): string {
  const lines = [
    "InReview stored-content summary",
    "",
    `Kind: ${kindLabel(file.kind)}`,
    `Status: ${statusLabel(file.status)}`,
    `Original path: ${safeValue(file.originalPath)}`,
    `Modified path: ${safeValue(file.currentPath)}`,
  ];
  if (file.summary?.kind === "binary") {
    lines.push(
      `Original size: ${String(file.summary.originalByteLength)} bytes`,
      `Modified size: ${String(file.summary.modifiedByteLength)} bytes`,
    );
  } else if (file.summary?.kind === "symbolic-link") {
    lines.push(
      `Original target: ${safeValue(file.summary.originalTarget)}`,
      `Modified target: ${safeValue(file.summary.modifiedTarget)}`,
    );
  } else if (file.summary?.kind === "non-regular") {
    lines.push(
      `Original type: ${safeValue(file.summary.originalType)}`,
      `Modified type: ${safeValue(file.summary.modifiedType)}`,
    );
  } else {
    lines.push("Metadata: No additional stored metadata is available.");
  }
  return `${lines.join("\n")}\n`;
}

function parseRevealFileRequest(value: unknown): RevealFileRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest();
  }
  const request = value as Record<string, unknown>;
  const view = parseView(request.view);
  if (
    Object.keys(request).length !== 5 ||
    typeof request.reviewId !== "string" ||
    typeof request.snapshotId !== "string" ||
    typeof request.fileId !== "string" ||
    typeof request.readOnly !== "boolean" ||
    request.reviewId.length === 0 ||
    request.snapshotId.length === 0 ||
    request.fileId.length === 0
  ) {
    throw invalidRequest();
  }
  return {
    reviewId: request.reviewId,
    snapshotId: request.snapshotId,
    view,
    fileId: request.fileId,
    readOnly: request.readOnly,
  };
}

function parseView(value: unknown): ViewIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalidRequest();
  }
  const view = value as Record<string, unknown>;
  if (view.mode === "combined" && Object.keys(view).length === 1) {
    return { mode: "combined" };
  }
  if (
    view.mode === "per-change" &&
    Object.keys(view).length === 2 &&
    typeof view.changeId === "string" &&
    view.changeId.length > 0
  ) {
    return { mode: "per-change", changeId: view.changeId };
  }
  throw invalidRequest();
}

function invalidRequest(): NativeDiffError {
  return new NativeDiffError(
    "invalid-request",
    "The selected file target is invalid. Refresh the InReview view and try again.",
  );
}

function identityFor(
  request: RevealFileRequest,
  repositoryPath: string,
  side: "original" | "modified",
): VirtualDocumentIdentity {
  return {
    reviewId: request.reviewId,
    snapshotId: request.snapshotId,
    view: request.view,
    fileId: request.fileId,
    side,
    repositoryPath,
    readOnly: request.readOnly,
  };
}

function sameView(left: ViewIdentity, right: ViewIdentity): boolean {
  return viewIdentityKey(left) === viewIdentityKey(right);
}

function diffTitle(
  record: ReviewRecord,
  snapshot: Snapshot,
  view: ViewManifest,
  file: FileManifestEntry,
): string {
  const path =
    file.originalPath !== null &&
    file.currentPath !== null &&
    file.originalPath !== file.currentPath
      ? `${file.originalPath} → ${file.currentPath}`
      : (file.currentPath ?? file.originalPath ?? "Unknown file");
  const viewLabel =
    view.identity.mode === "combined"
      ? "Combined"
      : `Change ${shortId(view.identity.changeId)}`;
  const stateLabel =
    snapshot.id === record.review.currentSnapshotId
      ? record.review.state === "archived"
        ? "Archived"
        : "Current"
      : `Historical ${formatTimestamp(snapshot.capturedAt)}`;
  return `${record.review.name} — ${viewLabel} — ${stateLabel} — ${path}`;
}

function safeValue(value: string | null): string {
  if (value === null) {
    return "(none)";
  }
  const truncated = value.length > 2_048 ? `${value.slice(0, 2_048)}…` : value;
  return JSON.stringify(truncated);
}

function shortId(value: string): string {
  return value.slice(0, 12);
}

function formatTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function kindLabel(kind: FileManifestEntry["kind"]): string {
  return {
    text: "Text",
    binary: "Binary",
    "symbolic-link": "Symbolic link",
    "non-regular": "Non-regular entry",
  }[kind];
}

function statusLabel(status: FileManifestEntry["status"]): string {
  return {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
  }[status];
}
