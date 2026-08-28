import { z } from "zod";

import {
  fileKindSchema,
  fileStatusSchema,
  fileSummarySchema,
  lineRangeSchema,
  patchHunkSchema,
  viewIdentitySchema,
} from "../domain/review";
import {
  COMMENT_BATCH_MAX_SIZE,
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_QUERY_MAX_LIMIT,
} from "../review/commentService";

const identifierSchema = z.string().min(1).max(512);
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !hasControlCharacters(value), {
    message: "A repository path cannot contain control characters.",
  });
const timestampSchema = z.iso.datetime({ offset: true });
const uuidSchema = z.uuid();

export const mcpErrorCodeSchema = z.enum([
  "WORKSPACE_MISMATCH",
  "NOT_CONNECTED",
  "NO_ACTIVE_REVIEW",
  "STALE_CONNECTION",
  "COMMENT_NOT_FOUND",
  "COMMENT_CONFLICT",
  "COMMENT_IMMUTABLE",
  "INVALID_COMMENT",
  "INVALID_ARGUMENT",
  "INVALID_DATA",
  "STORAGE_FAILURE",
  "INTERNAL_ERROR",
]);

export const mcpToolErrorSchema = z
  .object({
    code: mcpErrorCodeSchema,
    message: z.string().min(1).max(1_024),
    reconnectRequired: z.boolean(),
  })
  .strict();

const errorOutputSchema = z
  .object({
    status: z.literal("error"),
    error: mcpToolErrorSchema,
  })
  .strict();

const commentCountsOutputSchema = z
  .object({
    open: z.number().int().nonnegative(),
    outdated: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  })
  .strict();

const reviewSummarySchema = z
  .object({
    reviewId: uuidSchema,
    name: z.string().min(1).max(512),
    state: z.literal("active"),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    requestedChangeCount: z.number().int().positive(),
    actualChangeCount: z.number().int().positive(),
    commentCounts: commentCountsOutputSchema,
  })
  .strict();

const snapshotSummarySchema = z
  .object({
    snapshotId: uuidSchema,
    capturedAt: timestampSchema,
    baseCommitId: identifierSchema,
    headCommitId: identifierSchema,
    changeCount: z.number().int().positive(),
    fileCount: z.number().int().nonnegative(),
    changedLineCount: z.number().int().nonnegative(),
    views: z.array(viewIdentitySchema).min(1),
  })
  .strict();

export const connectWorkspaceInputSchema = z
  .object({
    workspace_root: repositoryPathSchema,
  })
  .strict();

export const connectWorkspaceOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("connected"),
      workspace: z
        .object({
          canonicalRoot: repositoryPathSchema,
          repositoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
      activeReview: reviewSummarySchema,
      currentSnapshot: snapshotSummarySchema,
      capabilities: z
        .object({
          tools: z.tuple([
            z.literal("read_review_metadata"),
            z.literal("read_comments"),
            z.literal("reply_comment"),
            z.literal("close_comments"),
          ]),
          agentAuthor: z.literal("Agent"),
          canReadFileContents: z.literal(false),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("no_active_review"),
      workspace: z
        .object({
          canonicalRoot: repositoryPathSchema,
          repositoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
      message: z.literal(
        "This workspace has no active review. Start a review, then reconnect.",
      ),
      capabilities: z
        .object({
          tools: z.tuple([z.literal("connect_workspace")]),
          agentAuthor: z.literal("Agent"),
          canReadFileContents: z.literal(false),
        })
        .strict(),
    })
    .strict(),
  errorOutputSchema,
]);

export const readReviewMetadataInputSchema = z.object({}).strict();

const metadataFileSchema = z
  .object({
    fileId: identifierSchema,
    status: fileStatusSchema,
    kind: fileKindSchema,
    originalPath: repositoryPathSchema.nullable(),
    currentPath: repositoryPathSchema.nullable(),
    addedLines: z.number().int().nonnegative(),
    deletedLines: z.number().int().nonnegative(),
    commentableRanges: z.array(lineRangeSchema).optional(),
    summary: fileSummarySchema.optional(),
  })
  .strict();

const metadataViewSchema = z
  .object({
    identity: viewIdentitySchema,
    baseCommitId: identifierSchema,
    headCommitId: identifierSchema,
    changedLineCount: z.number().int().nonnegative(),
    files: z.array(metadataFileSchema),
  })
  .strict();

const metadataChangeSchema = z
  .object({
    changeId: identifierSchema,
    normalChangeId: identifierSchema.optional(),
    commitId: identifierSchema,
    parentCommitId: identifierSchema,
    parentCommitIds: z.array(identifierSchema).optional(),
    description: z.string(),
    subject: z.string().optional(),
  })
  .strict();

export const readReviewMetadataOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      review: z
        .object({
          reviewId: uuidSchema,
          name: z.string().min(1).max(512),
          state: z.literal("active"),
          createdAt: timestampSchema,
          updatedAt: timestampSchema,
          archivedAt: z.null(),
          requestedChangeCount: z.number().int().positive(),
          actualChangeCount: z.number().int().positive(),
          orderedChangeIds: z.array(identifierSchema).min(1),
          commentCounts: commentCountsOutputSchema,
        })
        .strict(),
      currentSnapshot: z
        .object({
          snapshotId: uuidSchema,
          capturedAt: timestampSchema,
          operationId: identifierSchema,
          orderedChangeIds: z.array(identifierSchema).min(1),
          changes: z.array(metadataChangeSchema).min(1),
          baseCommitId: identifierSchema,
          headCommitId: identifierSchema,
          views: z.array(metadataViewSchema).min(1),
        })
        .strict(),
    })
    .strict(),
  errorOutputSchema,
]);

const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(isRepositoryRelativePath, {
    message:
      "A file filter must be a normalized repository-relative path without traversal.",
  });

export const readCommentsInputSchema = z
  .object({
    status: z.enum(["open", "resolved", "all"]).optional(),
    outdated: z.boolean().optional(),
    file: repositoryRelativePathSchema.optional(),
    comment_ids: z.array(uuidSchema).max(COMMENT_BATCH_MAX_SIZE).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(COMMENT_QUERY_MAX_LIMIT).optional(),
  })
  .strict()
  .superRefine(({ comment_ids }, context) => {
    if (
      comment_ids !== undefined &&
      new Set(comment_ids).size !== comment_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["comment_ids"],
        message: "Comment IDs must be unique.",
      });
    }
  });

const commentMessageOutputSchema = z
  .object({
    messageId: uuidSchema,
    author: z.enum(["human", "Agent"]),
    displayName: z.string().min(1).max(256),
    body: z.string().min(1).max(COMMENT_BODY_MAX_LENGTH),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const commentLocationSchema = z
  .object({
    snapshotId: uuidSchema,
    view: viewIdentitySchema,
    fileId: identifierSchema.nullable(),
    path: repositoryPathSchema,
    originalPath: repositoryPathSchema.nullable(),
    currentPath: repositoryPathSchema.nullable(),
    line: z.number().int().positive().nullable(),
    fileStatus: fileStatusSchema,
    targetLine: z.string().nullable(),
    storedHunk: patchHunkSchema.nullable(),
    fullFileContext: z
      .object({
        targetIndex: z.number().int().nonnegative(),
        lines: z.array(z.string()).min(1).max(11),
      })
      .strict()
      .nullable(),
  })
  .strict();

const currentCommentLocationSchema = z
  .object({
    snapshotId: uuidSchema,
    view: viewIdentitySchema,
    path: repositoryPathSchema,
    line: z.number().int().positive().nullable(),
  })
  .strict();

const commentThreadOutputSchema = z
  .object({
    commentId: uuidSchema,
    reviewId: uuidSchema,
    state: z.enum(["open", "resolved"]),
    outdated: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    resolvedAt: timestampSchema.nullable(),
    anchor: commentLocationSchema,
    currentLocation: currentCommentLocationSchema.nullable(),
    messages: z.array(commentMessageOutputSchema).min(1),
  })
  .strict();

export const readCommentsOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      comments: z.array(commentThreadOutputSchema),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict(),
  errorOutputSchema,
]);

export const replyCommentInputSchema = z
  .object({
    comment_id: uuidSchema,
    body: plainTextSchema(COMMENT_BODY_MAX_LENGTH),
  })
  .strict();

export const replyCommentOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      commentId: uuidSchema,
      threadState: z.literal("open"),
      message: commentMessageOutputSchema,
    })
    .strict(),
  errorOutputSchema,
]);

const closeCommentItemSchema = z
  .object({
    comment_id: uuidSchema,
    resolution_note: plainTextSchema(COMMENT_BODY_MAX_LENGTH).optional(),
  })
  .strict();

export const closeCommentsInputSchema = z
  .object({
    comments: z
      .array(closeCommentItemSchema)
      .min(1)
      .max(COMMENT_BATCH_MAX_SIZE),
  })
  .strict()
  .superRefine(({ comments }, context) => {
    const ids = comments.map(({ comment_id }) => comment_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["comments"],
        message: "Each comment ID can occur only once.",
      });
    }
  });

export const closeCommentsOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      resolved: z.array(
        z
          .object({
            commentId: uuidSchema,
            state: z.literal("resolved"),
          })
          .strict(),
      ),
    })
    .strict(),
  errorOutputSchema,
]);

export type McpToolError = z.infer<typeof mcpToolErrorSchema>;
export type ConnectWorkspaceInput = z.infer<typeof connectWorkspaceInputSchema>;
export type ReadCommentsInput = z.infer<typeof readCommentsInputSchema>;
export type ReplyCommentInput = z.infer<typeof replyCommentInputSchema>;
export type CloseCommentsInput = z.infer<typeof closeCommentsInputSchema>;

function plainTextSchema(maxLength: number): z.ZodString {
  return z
    .string()
    .max(maxLength)
    .refine((value) => value.trim().length > 0, {
      message: "Text cannot be empty.",
    })
    .refine((value) => !hasControlCharacters(value, true), {
      message: "Text must be plain text without control characters.",
    });
}

function hasControlCharacters(value: string, allowWhitespace = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x7f ||
      (code < 0x20 &&
        !(allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)))
    ) {
      return true;
    }
  }
  return false;
}

function isRepositoryRelativePath(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-z]:/iu.test(value) ||
    value.includes("\\") ||
    hasControlCharacters(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return (
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    !value.endsWith("/")
  );
}
