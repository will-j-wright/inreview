import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type {
  CommentMessage,
  CommentThread,
  ReviewRecord,
} from "../domain/comments";
import { DomainError, StorageError } from "../domain/errors";
import type {
  FileManifestEntry,
  Snapshot,
  ViewManifest,
} from "../domain/review";
import {
  CommentServiceError,
  type CommentQuery,
} from "../review/commentService";
import { ReviewLifecycleError } from "../review/errors";
import {
  closeCommentsOutputSchema,
  connectWorkspaceOutputSchema,
  type CloseCommentsInput,
  type ConnectWorkspaceInput,
  type McpToolError,
  readCommentsOutputSchema,
  type ReadCommentsInput,
  readReviewMetadataOutputSchema,
  replyCommentOutputSchema,
  type ReplyCommentInput,
} from "./schemas";
import type {
  McpReviewToolDependencies,
  McpSessionReviewBinding,
} from "./toolContext";

type ToolHandler<T> = (input: T) => Promise<CallToolResult>;

export interface McpReviewToolHandlers {
  readonly connectWorkspace: ToolHandler<ConnectWorkspaceInput>;
  readonly readReviewMetadata: ToolHandler<Record<string, never>>;
  readonly readComments: ToolHandler<ReadCommentsInput>;
  readonly replyComment: ToolHandler<ReplyCommentInput>;
  readonly closeComments: ToolHandler<CloseCommentsInput>;
}

export function createMcpReviewToolHandlers(
  dependencies: McpReviewToolDependencies,
): McpReviewToolHandlers {
  const { service, session } = dependencies;

  return {
    connectWorkspace: async (input) =>
      runTool(connectWorkspaceOutputSchema, async () => {
        const canonicalRoot = validateWorkspaceRoot(
          input.workspace_root,
          service.canonicalRepositoryRoot,
        );
        const active = await service.getActiveReviewOrUndefined();
        if (active?.review.state !== "active") {
          session.binding = undefined;
          return {
            status: "no_active_review" as const,
            workspace: workspaceIdentity(canonicalRoot, service.storageKey),
            message:
              "This workspace has no active review. Start a review, then reconnect." as const,
            capabilities: {
              tools: ["connect_workspace"] as ["connect_workspace"],
              agentAuthor: "Agent" as const,
              canReadFileContents: false as const,
            },
          };
        }

        const snapshot = currentSnapshot(active);
        session.binding = {
          canonicalWorkspaceRoot: canonicalRoot,
          repositoryFingerprint: service.storageKey,
          reviewId: active.review.id,
          snapshotId: snapshot.id,
        };
        return {
          status: "connected" as const,
          workspace: workspaceIdentity(canonicalRoot, service.storageKey),
          activeReview: reviewSummary(active, snapshot),
          currentSnapshot: snapshotSummary(snapshot),
          capabilities: {
            tools: [
              "read_review_metadata",
              "read_comments",
              "reply_comment",
              "close_comments",
            ] as [
              "read_review_metadata",
              "read_comments",
              "reply_comment",
              "close_comments",
            ],
            agentAuthor: "Agent" as const,
            canReadFileContents: false as const,
          },
        };
      }),

    readReviewMetadata: async () =>
      runTool(readReviewMetadataOutputSchema, async () => {
        const active = await requireBoundActiveReview(dependencies);
        const snapshot = currentSnapshot(active);
        return {
          status: "success" as const,
          review: {
            reviewId: active.review.id,
            name: active.review.name,
            state: "active" as const,
            createdAt: active.review.createdAt,
            updatedAt: active.review.updatedAt,
            archivedAt: null,
            requestedChangeCount: active.review.requestedChangeCount,
            actualChangeCount: snapshot.changes.length,
            orderedChangeIds: [...active.review.orderedChangeIds],
            commentCounts: { ...active.review.counts },
          },
          currentSnapshot: {
            snapshotId: snapshot.id,
            capturedAt: snapshot.capturedAt,
            operationId: snapshot.operationId,
            orderedChangeIds: [...snapshot.orderedChangeIds],
            changes: snapshot.changes.map((change) => ({
              changeId: change.changeId,
              ...(change.normalChangeId === undefined
                ? {}
                : { normalChangeId: change.normalChangeId }),
              commitId: change.commitId,
              parentCommitId: change.parentCommitId,
              ...(change.parentCommitIds === undefined
                ? {}
                : { parentCommitIds: [...change.parentCommitIds] }),
              description: change.description,
              ...(change.subject === undefined ? {} : { subject: change.subject }),
            })),
            baseCommitId: snapshot.baseCommitId,
            headCommitId: snapshot.headCommitId,
            views: snapshot.views.map(safeViewManifest),
          },
        };
      }),

    readComments: async (input) =>
      runTool(readCommentsOutputSchema, async () => {
        const active = await requireBoundActiveReview(dependencies);
        const query: CommentQuery = {
          ...(input.status === undefined
            ? {}
            : {
                status:
                  input.status === "open" ? ("unresolved" as const) : input.status,
              }),
          ...(input.outdated === undefined ? {} : { outdated: input.outdated }),
          ...(input.file === undefined ? {} : { file: input.file }),
          ...(input.comment_ids === undefined
            ? {}
            : { ids: [...input.comment_ids] }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        };
        const page = await service.commentService.queryReviewThreads(
          active.review.id,
          query,
        );
        return {
          status: "success" as const,
          comments: page.items.map(commentThreadOutput),
          nextCursor: page.nextCursor,
        };
      }),

    replyComment: async (input) =>
      runTool(replyCommentOutputSchema, async () => {
        const active = await requireBoundActiveReview(dependencies);
        const message = await service.commentService.replyAsAgent({
          reviewId: active.review.id,
          commentId: input.comment_id,
          body: input.body,
        });
        return {
          status: "success" as const,
          commentId: input.comment_id,
          threadState: "open" as const,
          message: commentMessageOutput(message),
        };
      }),

    closeComments: async (input) =>
      runTool(closeCommentsOutputSchema, async () => {
        const active = await requireBoundActiveReview(dependencies);
        const resolved = await service.commentService.resolveBatchAsAgent({
          reviewId: active.review.id,
          items: input.comments.map((item) => ({
            commentId: item.comment_id,
            ...(item.resolution_note === undefined
              ? {}
              : { note: item.resolution_note }),
          })),
        });
        return {
          status: "success" as const,
          resolved: resolved.map(({ commentId }) => ({
            commentId,
            state: "resolved" as const,
          })),
        };
      }),
  };
}

async function requireBoundActiveReview(
  dependencies: McpReviewToolDependencies,
): Promise<ReviewRecord> {
  const { binding } = dependencies.session;
  if (binding === undefined) {
    throw new ToolFault(
      "NOT_CONNECTED",
      "Call connect_workspace before using this tool.",
      false,
    );
  }
  assertBindingMatchesService(binding, dependencies);
  const active = await dependencies.service.getActiveReviewOrUndefined();
  if (
    active?.review.state !== "active" ||
    active.review.id !== binding.reviewId ||
    active.review.currentSnapshotId !== binding.snapshotId
  ) {
    throw new ToolFault(
      "STALE_CONNECTION",
      "The active review changed after this session connected. Call connect_workspace again.",
      true,
    );
  }
  return active;
}

function assertBindingMatchesService(
  binding: McpSessionReviewBinding,
  dependencies: McpReviewToolDependencies,
): void {
  if (
    binding.repositoryFingerprint !== dependencies.service.storageKey ||
    !samePlatformPath(
      binding.canonicalWorkspaceRoot,
      dependencies.service.canonicalRepositoryRoot,
    )
  ) {
    dependencies.session.binding = undefined;
    throw new ToolFault(
      "STALE_CONNECTION",
      "The MCP session workspace binding is no longer valid. Call connect_workspace again.",
      true,
    );
  }
}

function validateWorkspaceRoot(input: string, expectedRoot: string): string {
  if (!path.isAbsolute(input)) {
    throw new ToolFault(
      "WORKSPACE_MISMATCH",
      "workspace_root must be an absolute path to this server's jj workspace root.",
      false,
    );
  }
  const withoutRoot = input.slice(path.parse(input).root.length);
  if (
    withoutRoot
      .split(/[\\/]/u)
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new ToolFault(
      "WORKSPACE_MISMATCH",
      "workspace_root cannot contain traversal segments.",
      false,
    );
  }
  const normalized = path.normalize(input);
  const expected = path.normalize(expectedRoot);
  if (!samePlatformPath(normalized, expected)) {
    throw new ToolFault(
      "WORKSPACE_MISMATCH",
      "workspace_root does not match this server's jj workspace root.",
      false,
    );
  }
  return expected;
}

function samePlatformPath(left: string, right: string): boolean {
  const leftKey = comparablePath(left);
  const rightKey = comparablePath(right);
  return leftKey === rightKey;
}

function comparablePath(value: string): string {
  const normalized = stripTrailingSeparators(path.normalize(value));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function stripTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  let result = value;
  while (result.length > root.length && /[\\/]$/u.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

function workspaceIdentity(canonicalRoot: string, repositoryFingerprint: string) {
  return { canonicalRoot, repositoryFingerprint };
}

function currentSnapshot(record: ReviewRecord): Snapshot {
  const snapshot = record.snapshots.find(
    ({ id }) => id === record.review.currentSnapshotId,
  );
  if (snapshot === undefined) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "The current review snapshot is unavailable.",
    );
  }
  return snapshot;
}

function reviewSummary(record: ReviewRecord, snapshot: Snapshot) {
  return {
    reviewId: record.review.id,
    name: record.review.name,
    state: "active" as const,
    createdAt: record.review.createdAt,
    updatedAt: record.review.updatedAt,
    requestedChangeCount: record.review.requestedChangeCount,
    actualChangeCount: snapshot.changes.length,
    commentCounts: { ...record.review.counts },
  };
}

function snapshotSummary(snapshot: Snapshot) {
  const combined = snapshot.views.find(({ identity }) => identity.mode === "combined");
  return {
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    baseCommitId: snapshot.baseCommitId,
    headCommitId: snapshot.headCommitId,
    changeCount: snapshot.changes.length,
    fileCount: combined?.files.length ?? 0,
    changedLineCount: combined?.changedLineCount ?? 0,
    views: snapshot.views.map(({ identity }) => identity),
  };
}

function safeViewManifest(view: ViewManifest) {
  return {
    identity: view.identity,
    baseCommitId: view.baseCommitId,
    headCommitId: view.headCommitId,
    changedLineCount: view.changedLineCount,
    files: view.files.map(safeFileManifest),
  };
}

function safeFileManifest(file: FileManifestEntry) {
  return {
    fileId: file.fileId,
    status: file.status,
    kind: file.kind,
    originalPath: file.originalPath,
    currentPath: file.currentPath,
    addedLines: file.addedLines,
    deletedLines: file.deletedLines,
    ...(file.commentableRanges === undefined
      ? {}
      : {
          commentableRanges: file.commentableRanges.map((range) => ({
            ...range,
          })),
        }),
    ...(file.summary === undefined ? {} : { summary: { ...file.summary } }),
  };
}

function commentThreadOutput(thread: CommentThread) {
  const anchorPath = thread.anchor.currentPath ?? thread.anchor.originalPath;
  if (anchorPath === null) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "A comment anchor has no repository-relative path.",
    );
  }
  return {
    commentId: thread.commentId,
    reviewId: thread.reviewId,
    state: thread.state,
    outdated: thread.currentness === "outdated",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    resolvedAt: thread.resolvedAt,
    anchor: {
      snapshotId: thread.anchor.snapshotId,
      view: thread.anchor.view,
      fileId: thread.anchor.fileId ?? null,
      path: anchorPath,
      originalPath: thread.anchor.originalPath,
      currentPath: thread.anchor.currentPath,
      line:
        thread.anchor.target.kind === "line" ? thread.anchor.target.line : null,
      fileStatus: thread.anchor.fileStatus,
      targetLine: thread.anchor.targetText,
      storedHunk: thread.anchor.storedHunk,
    },
    currentLocation:
      thread.projection === null
        ? null
        : {
            snapshotId: thread.projection.snapshotId,
            view: thread.projection.view,
            path: thread.projection.path,
            line:
              thread.projection.target.kind === "line"
                ? thread.projection.target.line
                : null,
          },
    messages: thread.messages.map(commentMessageOutput),
  };
}

function commentMessageOutput(message: CommentMessage) {
  return {
    messageId: message.id,
    author: message.author === "agent" ? ("Agent" as const) : ("human" as const),
    displayName: message.displayName,
    body: message.body,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

async function runTool<T extends object>(
  schema: z.ZodType<T>,
  operation: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    return result(schema, await operation(), false);
  } catch (error) {
    return result(schema, { status: "error", error: mapError(error) }, true);
  }
}

function result<T extends object>(
  schema: z.ZodType<T>,
  value: unknown,
  isError: boolean,
): CallToolResult {
  const parsed = schema.parse(value);
  const structuredContent = Object.fromEntries(Object.entries(parsed));
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

class ToolFault extends Error {
  public constructor(
    public readonly code: McpToolError["code"],
    message: string,
    public readonly reconnectRequired: boolean,
  ) {
    super(message);
    this.name = "ToolFault";
  }
}

function mapError(error: unknown): McpToolError {
  if (error instanceof ToolFault) {
    return {
      code: error.code,
      message: error.message,
      reconnectRequired: error.reconnectRequired,
    };
  }
  if (error instanceof CommentServiceError) {
    const code = commentErrorCode(error);
    return {
      code,
      message: commentErrorMessage(code),
      reconnectRequired: error.code === "stale",
    };
  }
  if (error instanceof ReviewLifecycleError) {
    if (
      error.code === "no-active-review" ||
      error.code === "stale-review" ||
      error.code === "archived-read-only"
    ) {
      return {
        code:
          error.code === "no-active-review"
            ? "NO_ACTIVE_REVIEW"
            : "STALE_CONNECTION",
        message:
          error.code === "no-active-review"
            ? "This workspace has no active review."
            : "The active review changed. Call connect_workspace again.",
        reconnectRequired: error.code !== "no-active-review",
      };
    }
    return {
      code: "INVALID_ARGUMENT",
      message: "The review operation conflicts with the current review state.",
      reconnectRequired: false,
    };
  }
  if (error instanceof DomainError) {
    return {
      code: "INVALID_DATA",
      message: "Stored review data failed validation.",
      reconnectRequired: false,
    };
  }
  if (error instanceof StorageError) {
    return {
      code: "STORAGE_FAILURE",
      message: "The review store could not complete the operation.",
      reconnectRequired: false,
    };
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return {
      code: "INVALID_ARGUMENT",
      message: "The tool arguments are invalid.",
      reconnectRequired: false,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The MCP review tool could not complete the operation.",
    reconnectRequired: false,
  };
}

function commentErrorCode(
  error: CommentServiceError,
): McpToolError["code"] {
  switch (error.code) {
    case "not-found":
      return "COMMENT_NOT_FOUND";
    case "stale":
      return "STALE_CONNECTION";
    case "immutable":
      return "COMMENT_IMMUTABLE";
    case "invalid-anchor":
    case "invalid-author":
      return "INVALID_COMMENT";
    case "duplicate":
    case "conflict":
      return "COMMENT_CONFLICT";
  }
}

function commentErrorMessage(code: McpToolError["code"]): string {
  switch (code) {
    case "COMMENT_NOT_FOUND":
      return "The comment thread does not exist in the connected review.";
    case "STALE_CONNECTION":
      return "The review or comment changed. Call connect_workspace again.";
    case "COMMENT_IMMUTABLE":
      return "The comment cannot be changed.";
    case "INVALID_COMMENT":
      return "The comment request is invalid.";
    default:
      return "The comment operation conflicts with the current thread state.";
  }
}
