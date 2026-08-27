import { z } from "zod";

import { DomainError } from "./errors";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(1).max(512);
const pathSchema = z.string().min(1).max(32_768);
const timestampSchema = z.iso.datetime({ offset: true });
const uuidSchema = z.uuid();

export const reviewStateSchema = z.enum(["active", "archived"]);
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const commentCountsSchema = z
  .object({
    open: z.number().int().nonnegative(),
    outdated: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  })
  .strict();
export type CommentCounts = z.infer<typeof commentCountsSchema>;

export const blobReferenceSchema = z
  .object({
    sha256: sha256Schema,
    byteLength: z.number().int().nonnegative(),
    encoding: z.literal("gzip"),
  })
  .strict();
export type BlobReference = z.infer<typeof blobReferenceSchema>;

export const fileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
]);
export type FileStatus = z.infer<typeof fileStatusSchema>;

export const fileKindSchema = z.enum([
  "text",
  "binary",
  "symbolic-link",
  "non-regular",
]);
export type FileKind = z.infer<typeof fileKindSchema>;

export const viewIdentitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("combined") }).strict(),
  z
    .object({
      mode: z.literal("per-change"),
      changeId: identifierSchema,
    })
    .strict(),
]);
export type ViewIdentity = z.infer<typeof viewIdentitySchema>;

export function viewIdentityKey(view: ViewIdentity): string {
  return view.mode === "combined" ? "combined" : `change:${view.changeId}`;
}

export const patchLineSchema = z
  .object({
    kind: z.enum(["context", "addition", "deletion"]),
    content: z.string(),
    oldLine: z.number().int().positive().nullable(),
    newLine: z.number().int().positive().nullable(),
    noNewlineAtEnd: z.boolean().optional(),
  })
  .strict();
export type PatchLine = z.infer<typeof patchLineSchema>;

export const patchHunkSchema = z
  .object({
    header: z.string(),
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(patchLineSchema),
    raw: z.string().optional(),
  })
  .strict();
export type PatchHunk = z.infer<typeof patchHunkSchema>;

export const lineRangeSchema = z
  .object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine(({ start, end }) => start <= end, "A line range must not be reversed.");
export type LineRange = z.infer<typeof lineRangeSchema>;

export const fileSummarySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      encoding: z.enum(["utf-8", "windows-1252"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("binary"),
      originalByteLength: z.number().int().nonnegative(),
      modifiedByteLength: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("symbolic-link"),
      originalTarget: z.string().nullable(),
      modifiedTarget: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("non-regular"),
      originalType: z.string().nullable(),
      modifiedType: z.string().nullable(),
    })
    .strict(),
]);
export type FileSummary = z.infer<typeof fileSummarySchema>;

export const fileManifestEntrySchema = z
  .object({
    fileId: identifierSchema,
    status: fileStatusSchema,
    kind: fileKindSchema,
    originalPath: pathSchema.nullable(),
    currentPath: pathSchema.nullable(),
    originalContent: blobReferenceSchema.nullable(),
    modifiedContent: blobReferenceSchema.nullable(),
    patch: blobReferenceSchema.nullable(),
    hunks: z.array(patchHunkSchema),
    addedLines: z.number().int().nonnegative(),
    deletedLines: z.number().int().nonnegative(),
    commentableRanges: z.array(lineRangeSchema).optional(),
    summary: fileSummarySchema.optional(),
  })
  .strict()
  .superRefine((file, context) => {
    const contentRequired =
      file.kind === "text" || file.kind === "symbolic-link";
    if (
      contentRequired &&
      file.status === "added" &&
      (file.originalPath !== null ||
        file.originalContent !== null ||
        file.currentPath === null ||
        file.modifiedContent === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "An added file must contain only new-side path and content.",
      });
    }
    if (
      contentRequired &&
      file.status === "deleted" &&
      (file.currentPath !== null ||
        file.originalPath === null ||
        file.originalContent === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A deleted file must contain an original-side path and content.",
      });
    }
    if (
      contentRequired &&
      file.status !== "added" &&
      file.status !== "deleted" &&
      (file.originalPath === null ||
        file.currentPath === null ||
        file.originalContent === null ||
        file.modifiedContent === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A changed file must contain paths and content for both sides.",
      });
    }
    if (file.originalPath === null && file.currentPath === null) {
      context.addIssue({ code: "custom", message: "A file must have at least one path." });
    }
    if (file.kind !== "text" && file.hunks.length !== 0) {
      context.addIssue({ code: "custom", message: "Only text files can contain parsed hunks." });
    }
  });
export type FileManifestEntry = z.infer<typeof fileManifestEntrySchema>;

export const viewManifestSchema = z
  .object({
    identity: viewIdentitySchema,
    baseCommitId: identifierSchema,
    headCommitId: identifierSchema,
    files: z.array(fileManifestEntrySchema),
    changedLineCount: z.number().int().nonnegative(),
  })
  .strict();
export type ViewManifest = z.infer<typeof viewManifestSchema>;

export const snapshotChangeSchema = z
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
export type SnapshotChange = z.infer<typeof snapshotChangeSchema>;

export const snapshotOperationSchema = z
  .object({
    id: identifierSchema,
    parentIds: z.array(identifierSchema),
    description: z.string(),
    timestamp: timestampSchema,
    snapshot: z.boolean(),
    root: z.boolean(),
  })
  .strict();
export type SnapshotOperation = z.infer<typeof snapshotOperationSchema>;

export const snapshotSchema = z
  .object({
    id: uuidSchema,
    capturedAt: timestampSchema,
    operationId: identifierSchema,
    operation: snapshotOperationSchema.optional(),
    orderedChangeIds: z.array(identifierSchema).min(1),
    changes: z.array(snapshotChangeSchema).min(1),
    baseCommitId: identifierSchema,
    headCommitId: identifierSchema,
    views: z.array(viewManifestSchema).min(1),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const changeIds = snapshot.changes.map(({ changeId }) => changeId);
    if (changeIds.join("\0") !== snapshot.orderedChangeIds.join("\0")) {
      context.addIssue({ code: "custom", message: "Snapshot changes must match ordered change IDs." });
    }
    const keys = snapshot.views.map(({ identity }) => viewIdentityKey(identity));
    const expectedKeys = [
      "combined",
      ...snapshot.orderedChangeIds.map((changeId) => `change:${changeId}`),
    ];
    if (
      new Set(keys).size !== keys.length ||
      keys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !keys.includes(key))
    ) {
      context.addIssue({
        code: "custom",
        message: "Snapshot views must contain one combined view and one view per change.",
      });
    }
  });
export type Snapshot = z.infer<typeof snapshotSchema>;

export const reviewSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(512),
    state: reviewStateSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.nullable(),
    repositoryFingerprint: sha256Schema,
    selectionMode: z.enum(["last-x", "range", "revset"]).optional(),
    requestedChangeCount: z.number().int().positive(),
    orderedChangeIds: z.array(identifierSchema).min(1),
    currentSnapshotId: uuidSchema,
    snapshotIds: z.array(uuidSchema).min(1),
    counts: commentCountsSchema,
  })
  .strict()
  .superRefine((review, context) => {
    if (!review.snapshotIds.includes(review.currentSnapshotId)) {
      context.addIssue({ code: "custom", message: "The current snapshot must be retained." });
    }
    if ((review.state === "active") === (review.archivedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only archived reviews can have an archive time.",
      });
    }
    if (new Set(review.snapshotIds).size !== review.snapshotIds.length) {
      context.addIssue({ code: "custom", message: "Snapshot IDs must be unique." });
    }
    if (
      Date.parse(review.updatedAt) < Date.parse(review.createdAt) ||
      (review.archivedAt !== null && Date.parse(review.archivedAt) < Date.parse(review.createdAt))
    ) {
      context.addIssue({ code: "custom", message: "Review timestamps are out of order." });
    }
  });
export type Review = z.infer<typeof reviewSchema>;

export function parseReview(value: unknown): Review {
  const parsed = reviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("INVALID_DOMAIN_DATA", "The review data is invalid.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
