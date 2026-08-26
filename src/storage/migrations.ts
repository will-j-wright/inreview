import { z } from "zod";

import { StorageError } from "../domain/errors";
import { reviewRecordSchema } from "../domain/comments";

export const CURRENT_SCHEMA_VERSION = 1;

export const reviewIndexEntrySchema = z
  .object({
    reviewId: z.uuid(),
    manifestFile: z.string().regex(/^[0-9a-f-]{36}\.json$/u),
    state: z.enum(["active", "archived"]),
    updatedAt: z.iso.datetime({ offset: true }),
    archivedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const reviewIndexManifestSchema = z
  .object({
    format: z.literal("inreview-index"),
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    activeReviewId: z.uuid().nullable(),
    reviews: z.array(reviewIndexEntrySchema),
  })
  .strict()
  .superRefine((index, context) => {
    const activeEntries = index.reviews.filter(({ state }) => state === "active");
    if (
      activeEntries.length > 1 ||
      (index.activeReviewId === null) !== (activeEntries.length === 0) ||
      (activeEntries[0]?.reviewId ?? null) !== index.activeReviewId ||
      new Set(index.reviews.map(({ reviewId }) => reviewId)).size !== index.reviews.length
    ) {
      context.addIssue({ code: "custom", message: "The review index is inconsistent." });
    }
  });

export type ReviewIndexManifest = z.infer<typeof reviewIndexManifestSchema>;
export type ReviewIndexEntry = z.infer<typeof reviewIndexEntrySchema>;

export const persistedReviewManifestSchema = z
  .object({
    format: z.literal("inreview-review"),
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    record: reviewRecordSchema,
  })
  .strict();
export type PersistedReviewManifest = z.infer<typeof persistedReviewManifestSchema>;

type ManifestKind = "index" | "review";
type Migrator = (value: Record<string, unknown>) => Record<string, unknown>;

const migrations: Record<ManifestKind, ReadonlyMap<number, Migrator>> = {
  index: new Map([
    [
      0,
      (value) => ({
        ...value,
        format: "inreview-index",
        schemaVersion: 1,
      }),
    ],
  ]),
  review: new Map([
    [
      0,
      (value) => ({
        ...value,
        format: "inreview-review",
        schemaVersion: 1,
      }),
    ],
  ]),
};

function migrate(kind: ManifestKind, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("CORRUPT_DATA", `The ${kind} manifest is not an object.`);
  }

  let current = { ...(value as Record<string, unknown>) };
  let version = current.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new StorageError("CORRUPT_DATA", `The ${kind} manifest has no valid schema version.`);
  }
  if ((version as number) > CURRENT_SCHEMA_VERSION) {
    throw new StorageError(
      "SCHEMA_TOO_NEW",
      `The ${kind} manifest uses schema version ${String(version)}; this build supports ${String(CURRENT_SCHEMA_VERSION)}.`,
    );
  }

  while ((version as number) < CURRENT_SCHEMA_VERSION) {
    const migration = migrations[kind].get(version as number);
    if (migration === undefined) {
      throw new StorageError(
        "MIGRATION_FAILED",
        `No ${kind} migration exists from schema version ${String(version)}.`,
      );
    }
    try {
      current = migration(current);
    } catch (error) {
      throw new StorageError(
        "MIGRATION_FAILED",
        `The ${kind} migration from schema version ${String(version)} failed.`,
        { cause: error },
      );
    }
    version = current.schemaVersion;
  }
  return current;
}

export function migrateAndParseIndex(value: unknown): ReviewIndexManifest {
  const parsed = reviewIndexManifestSchema.safeParse(migrate("index", value));
  if (!parsed.success) {
    throw new StorageError("CORRUPT_DATA", "The review index is invalid.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function migrateAndParseReview(value: unknown): PersistedReviewManifest {
  const parsed = persistedReviewManifestSchema.safeParse(migrate("review", value));
  if (!parsed.success) {
    throw new StorageError("CORRUPT_DATA", "The persisted review is invalid.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
