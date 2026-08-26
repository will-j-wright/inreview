import { z } from "zod";

import { DomainError } from "./errors";
import {
  fileStatusSchema,
  patchHunkSchema,
  reviewSchema,
  snapshotSchema,
  viewIdentitySchema,
} from "./review";

const timestampSchema = z.iso.datetime({ offset: true });
const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const pathSchema = z.string().min(1).max(32_768);

export const commentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file") }).strict(),
  z
    .object({
      kind: z.literal("line"),
      line: z.number().int().positive(),
    })
    .strict(),
]);
export type CommentTarget = z.infer<typeof commentTargetSchema>;

export const commentAnchorSchema = z
  .object({
    reviewId: uuidSchema.optional(),
    snapshotId: uuidSchema,
    view: viewIdentitySchema,
    fileId: z.string().min(1).max(512).optional(),
    target: commentTargetSchema,
    originalPath: pathSchema.nullable(),
    currentPath: pathSchema.nullable(),
    fileStatus: fileStatusSchema,
    targetText: z.string().nullable(),
    storedHunk: patchHunkSchema.nullable(),
    contextFingerprint: sha256Schema,
  })
  .strict()
  .superRefine((anchor, context) => {
    if (anchor.originalPath === null && anchor.currentPath === null) {
      context.addIssue({ code: "custom", message: "An anchor must have a file path." });
    }
    if (anchor.target.kind === "line" && anchor.currentPath === null) {
      context.addIssue({ code: "custom", message: "A line anchor must target the new side." });
    }
    if (anchor.target.kind === "file" && (anchor.targetText !== null || anchor.storedHunk !== null)) {
      context.addIssue({
        code: "custom",
        message: "A file anchor cannot contain line context.",
      });
    }
  });
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

export const commentProjectionSchema = z
  .object({
    snapshotId: uuidSchema,
    view: viewIdentitySchema,
    path: pathSchema,
    target: commentTargetSchema,
  })
  .strict();
export type CommentProjection = z.infer<typeof commentProjectionSchema>;

export const commentMessageSchema = z
  .object({
    id: uuidSchema,
    author: z.enum(["user", "agent"]),
    displayName: z.string().trim().min(1).max(256),
    body: z
      .string()
      .max(65_536)
      .refine((body) => body.trim().length > 0, "A comment body cannot be empty."),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.author === "agent" && message.displayName !== "Agent") {
      context.addIssue({ code: "custom", message: 'Agent messages must use the name "Agent".' });
    }
  });
export type CommentMessage = z.infer<typeof commentMessageSchema>;

export const commentThreadSchema = z
  .object({
    commentId: uuidSchema,
    reviewId: uuidSchema,
    anchor: commentAnchorSchema,
    projection: commentProjectionSchema.nullable(),
    state: z.enum(["open", "resolved"]),
    currentness: z.enum(["current", "outdated"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    resolvedAt: timestampSchema.nullable(),
    messages: z.array(commentMessageSchema).min(1),
  })
  .strict()
  .superRefine((thread, context) => {
    if ((thread.state === "resolved") !== (thread.resolvedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only resolved threads can have a resolution time.",
      });
    }
    if ((thread.currentness === "current") !== (thread.projection !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only current threads can have a current projection.",
      });
    }
  });
export type CommentThread = z.infer<typeof commentThreadSchema>;

export const reviewRecordSchema = z
  .object({
    review: reviewSchema,
    snapshots: z.array(snapshotSchema).min(1),
    threads: z.array(commentThreadSchema),
  })
  .strict();

export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export function parseReviewRecord(value: unknown): ReviewRecord {
  const parsed = reviewRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("INVALID_DOMAIN_DATA", "The review record is invalid.", {
      cause: parsed.error,
    });
  }

  const { review, snapshots, threads } = parsed.data;
  const snapshotIds = new Set(snapshots.map(({ id }) => id));
  if (
    snapshotIds.size !== snapshots.length ||
    review.snapshotIds.some((id) => !snapshotIds.has(id)) ||
    snapshots.some(({ id }) => !review.snapshotIds.includes(id))
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "The review and snapshot indexes do not match.",
    );
  }
  const currentSnapshot = snapshots.find(({ id }) => id === review.currentSnapshotId);
  if (
    currentSnapshot?.orderedChangeIds.join("\0") !==
    review.orderedChangeIds.join("\0")
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "The current snapshot does not match the review change selection.",
    );
  }
  if (
    new Set(threads.map(({ commentId }) => commentId)).size !== threads.length ||
    threads.some(
      ({ messages }) =>
        new Set(messages.map(({ id }) => id)).size !== messages.length,
    )
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Comment thread and message IDs must be unique within a review.",
    );
  }
  if (
    threads.some(
      (thread) =>
        thread.reviewId !== review.id ||
        (thread.anchor.reviewId !== undefined &&
          thread.anchor.reviewId !== review.id) ||
        !snapshotIds.has(thread.anchor.snapshotId) ||
        (thread.projection !== null && !snapshotIds.has(thread.projection.snapshotId)),
    )
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "A comment thread refers to data outside its review.",
    );
  }

  const counts = {
    open: threads.filter(
      ({ state, currentness }) => state === "open" && currentness === "current",
    ).length,
    outdated: threads.filter(
      ({ state, currentness }) => state === "open" && currentness === "outdated",
    ).length,
    resolved: threads.filter(({ state }) => state === "resolved").length,
  };
  if (
    review.counts.open !== counts.open ||
    review.counts.outdated !== counts.outdated ||
    review.counts.resolved !== counts.resolved
  ) {
    throw new DomainError("INVARIANT_VIOLATION", "The review comment counts are stale.");
  }

  return parsed.data;
}
